import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAttachment, contextFile, UPLOAD_DIRECTORY } from '../plugins/dsh-codex-sidebar/lib/security.mjs'

const base64 = (value) => Buffer.from(value).toString('base64')

async function workspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-attachment-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('phone attachments land inside the workspace with sanitized names', async () => {
  await workspace(async (cwd) => {
    const text = await saveAttachment(cwd, { name: '说明 文档.md', data: base64('# 标题\n正文') })
    assert.match(text.path, new RegExp(`^${UPLOAD_DIRECTORY}/`))
    assert.equal(text.name, '说明 文档.md'); assert.equal(text.binary, false); assert.equal(text.size, Buffer.byteLength('# 标题\n正文'))
    assert.equal(text.text, '# 标题\n正文')
    assert.equal(await readFile(join(cwd, text.path), 'utf8'), '# 标题\n正文')
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xff])
    const pdf = await saveAttachment(cwd, { name: '扫描件.pdf', data: binary.toString('base64') })
    assert.equal(pdf.binary, true); assert.equal(pdf.text, undefined)
    assert.ok((await readFile(join(cwd, pdf.path))).equals(binary))
    // Two uploads of the same name never overwrite each other.
    const again = await saveAttachment(cwd, { name: '说明 文档.md', data: base64('second') })
    assert.notEqual(again.path, text.path)
    assert.equal((await readdir(join(cwd, UPLOAD_DIRECTORY))).length, 3)
    assert.deepEqual((await readdir(cwd)).sort(), [UPLOAD_DIRECTORY])
  })
})

test('attachment names, payloads and sizes are validated before anything is written', async () => {
  await workspace(async (cwd) => {
    for (const name of ['../escape.txt', 'a/b.txt', 'a\\b.txt', '.', '..', '', ' x.txt', 'a\u0000b', 'x'.repeat(121)]) {
      await assert.rejects(saveAttachment(cwd, { name, data: base64('x') }), { code: 'attachment-name' })
    }
    await assert.rejects(saveAttachment(cwd, { name: 'a.txt', data: '' }), { code: 'attachment-invalid' })
    await assert.rejects(saveAttachment(cwd, { name: 'a.txt', data: '不是base64@@' }), { code: 'attachment-invalid' })
    await assert.rejects(saveAttachment(cwd, { name: 'a.txt' }), { code: 'attachment-invalid' })
    await assert.rejects(saveAttachment(cwd, { name: 'a.txt', data: Buffer.alloc(32 * 1024 * 1024 + 4).toString('base64') }), { code: 'attachment-too-large' })
    assert.deepEqual(await readdir(cwd), [])
  })
})

test('context inlining truncates long text, inlines small images and keeps other binaries by path', async () => {
  await workspace(async (cwd) => {
    await writeFile(join(cwd, 'small.txt'), '简短内容')
    assert.deepEqual(await contextFile(cwd, 'small.txt'), { path: 'small.txt', text: '简短内容', size: Buffer.byteLength('简短内容') })
    await writeFile(join(cwd, 'long.txt'), 'a'.repeat(200 * 1024))
    const truncated = await contextFile(cwd, 'long.txt')
    assert.equal(truncated.truncated, true); assert.equal(truncated.text.length, 128 * 1024); assert.equal(truncated.size, 200 * 1024)
    // Vision-capable models receive the pixels; the file stays on disk as well.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    await writeFile(join(cwd, 'image.png'), png)
    const image = await contextFile(cwd, 'image.png')
    assert.equal(image.binary, true); assert.equal(image.text, undefined); assert.equal(image.size, png.length)
    assert.deepEqual(image.image, { mime: 'image/png', data: png.toString('base64') })
    // A renamed text file is not an image: the type comes from the bytes, not the extension.
    await writeFile(join(cwd, 'fake.png'), 'not really a picture')
    assert.equal((await contextFile(cwd, 'fake.png')).image, undefined)
    // PDF and archives stay path references.
    await writeFile(join(cwd, 'scan.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))
    const pdf = await contextFile(cwd, 'scan.pdf')
    assert.equal(pdf.binary, true); assert.equal(pdf.image, undefined); assert.equal(pdf.imageTooLarge, undefined)
    // Oversized pictures are not inlined; the prompt tells the model to read the path instead.
    await writeFile(join(cwd, 'huge.png'), Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]))
    const huge = await contextFile(cwd, 'huge.png')
    assert.equal(huge.binary, true); assert.equal(huge.image, null); assert.equal(huge.imageTooLarge, true)
    await mkdir(join(cwd, 'folder'))
    await assert.rejects(contextFile(cwd, 'folder'), { code: 'file-invalid' })
    await writeFile(join(cwd, '.env'), 'TOKEN=secret')
    await assert.rejects(contextFile(cwd, '.env'), { code: 'sensitive-file' })
  })
})

test('webp and jpeg containers are recognized from their magic bytes only', async () => {
  await workspace(async (cwd) => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])
    await writeFile(join(cwd, 'a.webp'), webp)
    assert.equal((await contextFile(cwd, 'a.webp')).image.mime, 'image/webp')
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
    await writeFile(join(cwd, 'b.jpg'), jpeg)
    assert.equal((await contextFile(cwd, 'b.jpg')).image.mime, 'image/jpeg')
    const gif = Buffer.from('GIF89a' + 'rest')
    await writeFile(join(cwd, 'c.gif'), gif)
    assert.equal((await contextFile(cwd, 'c.gif')).image.mime, 'image/gif')
  })
})
