import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/** Desktop Java interoperability check, not an Android device acceptance test. */
class ZipCountCompatibility {
    public static void main(String[] args) throws Exception {
        Path path = Path.of(args[0]);
        int expected = Integer.parseInt(args[1]);
        int indexed = 0;
        try (ZipFile zip = new ZipFile(path.toFile(), StandardCharsets.UTF_8)) {
            if (zip.size() != expected) throw new AssertionError("ZipFile count " + zip.size());
            var names = new HashSet<String>();
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (!names.add(entry.getName())) throw new AssertionError("duplicate " + entry.getName());
                indexed++;
            }
            if (!"LINK:text/hello.txt".equals(zip.getEntry("alias").getComment())) throw new AssertionError("LINK comment");
            String text = new String(zip.getInputStream(zip.getEntry("unicode/测试.txt")).readAllBytes(), StandardCharsets.UTF_8);
            if (!"中文".equals(text)) throw new AssertionError("UTF-8 data");
        }
        int streamed = 0;
        byte[] buffer = new byte[8192];
        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(path), StandardCharsets.UTF_8)) {
            while (zip.getNextEntry() != null) {
                while (zip.read(buffer) != -1) { }
                zip.closeEntry();
                streamed++;
            }
        }
        if (indexed != expected || streamed != expected) throw new AssertionError("entry count mismatch");
        System.out.println("PASS Java ZipFile + ZipInputStream: " + expected + " entries, CRC/UTF-8/LINK readable");
    }
}
