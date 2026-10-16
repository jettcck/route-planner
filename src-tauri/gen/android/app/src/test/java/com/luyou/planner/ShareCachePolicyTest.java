package com.luyou.planner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class ShareCachePolicyTest {
    @Test
    public void recentSharesAreNeverEvictedToMakeRoom() throws Exception {
        File directory = Files.createTempDirectory("route-share-").toFile();
        try {
            List<File> files = new ArrayList<>();
            for (int i = 0; i < ShareCachePolicy.MAX_SHARE_FILES; i++) {
                File file = new File(directory, "share-" + i + ".txt");
                writeBytes(file, 1);
                files.add(file);
            }
            boolean rejected = false;
            try {
                ShareCachePolicy.INSTANCE.reserve(directory, 1, System.currentTimeMillis());
            } catch (IllegalStateException expected) {
                rejected = true;
            }
            assertTrue(rejected);
            for (File file : files) assertTrue(file.exists());
        } finally {
            deleteTree(directory);
        }
    }

    @Test
    public void expiredSharesAreRemovedBeforeAReservation() throws Exception {
        File directory = Files.createTempDirectory("route-share-").toFile();
        try {
            File file = new File(directory, "old.txt");
            writeBytes(file, 8);
            long now = System.currentTimeMillis();
            assertTrue(file.setLastModified(now - 8L * 24 * 60 * 60 * 1000));
            ShareCachePolicy.INSTANCE.reserve(directory, 1, now);
            assertFalse(file.exists());
        } finally {
            deleteTree(directory);
        }
    }

    private static void writeBytes(File file, int count) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(new byte[count]);
        }
    }

    private static void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        file.delete();
    }
}
