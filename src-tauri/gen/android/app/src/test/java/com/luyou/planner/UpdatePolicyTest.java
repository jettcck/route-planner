package com.luyou.planner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageManager;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class UpdatePolicyTest {
    private static final UpdatePolicy POLICY = UpdatePolicy.INSTANCE;
    private static final String UPSTREAM_REPOSITORY = "jettcck/route-planner";

    @Test
    public void failedReleaseRequestsCannotMeanLatestVersion() {
        for (int code : new int[]{403, 404, 429, 500, 503}) {
            assertThrows(IllegalStateException.class, () -> POLICY.requireReleaseSuccess(code));
        }
        POLICY.requireReleaseSuccess(200);
    }

    @SuppressWarnings("deprecation")
    @Test
    public void olderAndroidReadsLegacySignatures() {
        assertEquals(PackageManager.GET_SIGNATURES, POLICY.signatureFlags(24));
        assertEquals(PackageManager.GET_SIGNATURES, POLICY.signatureFlags(27));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, POLICY.signatureFlags(28));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, POLICY.signatureFlags(35));
    }

    @Test
    public void universalWinsRegardlessOfReleaseAssetOrder() {
        List<String> abis = Arrays.asList("arm64-v8a", "armeabi-v7a");
        List<String> assets = Arrays.asList("route-armv7.apk", "route-arm64.apk", "route-0.4.0-android.apk");
        String selected = assets.stream()
            .min((left, right) -> Integer.compare(
                rank(left, abis), rank(right, abis)))
            .orElseThrow();
        assertEquals("route-0.4.0-android.apk", selected);
        assertTrue(POLICY.assetRank("route-arm64.apk", abis) < POLICY.assetRank("route-armv7.apk", abis));
    }

    @Test
    public void incompatibleArchitectureIsRejected() {
        assertNull(POLICY.assetRank("route-arm64.apk", Arrays.asList("x86_64", "x86")));
        assertNull(POLICY.assetRank("route-x86_64.apk", Arrays.asList("x86")));
        assertNotNull(POLICY.assetRank("route-x86_64.apk", Arrays.asList("x86_64")));
        assertNotNull(POLICY.assetRank("route-i686.apk", Arrays.asList("x86")));
        assertNull(POLICY.assetRank("route-universal.apk.sig", Arrays.asList("arm64-v8a")));
    }

    @Test
    public void architectureMarkerWinsOverAndroidSuffix() {
        List<String> abis = Arrays.asList("arm64-v8a", "armeabi-v7a");
        assertEquals(Integer.valueOf(0), POLICY.assetRank("route-0.4.0-android.apk", abis));
        assertTrue(POLICY.assetRank("route-universal-arm64.apk", abis) > 0);
        assertTrue(POLICY.assetRank("route-arm64-android.apk", abis) > 0);
        assertTrue(POLICY.assetRank("route-arm64-android.apk", abis) < POLICY.assetRank("route-armv7-android.apk", abis));
        assertNull(POLICY.assetRank("route-arm64-android.apk", Arrays.asList("x86_64", "x86")));
        assertNull(POLICY.assetRank("route-x86_64-android.apk", Arrays.asList("arm64-v8a", "armeabi-v7a")));
        assertNull(POLICY.assetRank("route-universal-arm64.apk", Arrays.asList("x86_64", "x86")));
    }

    @Test
    public void incompleteOrEmptyDownloadsAreRejected() {
        assertThrows(IllegalStateException.class, () -> POLICY.validateDownload(0, -1));
        assertThrows(IllegalStateException.class, () -> POLICY.validateDownload(99, 100));
        assertThrows(IllegalStateException.class, () -> POLICY.validateDownload(101, 100));
        POLICY.validateDownload(100, 100);
        POLICY.validateDownload(100, -1);
    }

    @Test
    public void releaseDownloadRedirectsStayOnGitHubAssetHosts() {
        assertTrue(POLICY.isAllowedAssetUrl("https://github.com/jettcck/route-planner/releases/download/v0.4.0/route-universal.apk", UPSTREAM_REPOSITORY));
        assertTrue(POLICY.isAllowedDownloadUrl("https://github.com/jettcck/route-planner/releases/download/v0.4.0/route-universal.apk", UPSTREAM_REPOSITORY));
        assertTrue(POLICY.isAllowedDownloadUrl("https://release-assets.githubusercontent.com/123/route-universal.apk?sig=test", UPSTREAM_REPOSITORY));
        assertTrue(POLICY.isAllowedDownloadUrl("https://objects.githubusercontent.com/123/route-universal.apk", UPSTREAM_REPOSITORY));
        assertTrue(POLICY.isAllowedDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/492611621/d7d93107-34f2-4185-9435-da7ca3fdcebf?sig=test", UPSTREAM_REPOSITORY));
        assertFalse(POLICY.isAllowedDownloadUrl("https://release-assets.githubusercontent.com:8443/123/route-universal.apk", UPSTREAM_REPOSITORY));
        assertFalse(POLICY.isAllowedDownloadUrl("https://user:password@release-assets.githubusercontent.com/123/asset", UPSTREAM_REPOSITORY));
        assertFalse(POLICY.isAllowedAssetUrl("https://github.com:8443/jettcck/route-planner/releases/download/v0.4.0/route.apk", UPSTREAM_REPOSITORY));
        assertFalse(POLICY.isAllowedAssetUrl("https://github.com/other/repo/releases/download/v0.4.0/route-universal.apk", UPSTREAM_REPOSITORY));
        assertFalse(POLICY.isAllowedDownloadUrl("https://github.com.evil.example/route-universal.apk", UPSTREAM_REPOSITORY));
        assertFalse(POLICY.isAllowedDownloadUrl("http://release-assets.githubusercontent.com/route-universal.apk", UPSTREAM_REPOSITORY));
    }

    @Test
    public void onlyHttpRedirectStatusesAreFollowed() {
        for (int code : new int[]{301, 302, 303, 307, 308}) assertTrue(POLICY.isRedirect(code));
        for (int code : new int[]{200, 204, 304, 400, 403, 404, 500}) assertFalse(POLICY.isRedirect(code));
    }

    @Test
    public void forkRepositoryAssetsUseTheInjectedRepository() {
        String repository = "example-owner/example-route";
        String asset = "https://github.com/example-owner/example-route/releases/download/v0.4.0/route-universal.apk";
        assertTrue(POLICY.isAllowedAssetUrl(asset, repository));
        assertTrue(POLICY.isAllowedDownloadUrl(asset, repository));
        assertFalse(POLICY.isAllowedAssetUrl("https://github.com/jettcck/route-planner/releases/download/v0.4.0/route-universal.apk", repository));
        assertFalse(POLICY.isAllowedAssetUrl("https://github.com/example-owner/evil/releases/download/v0.4.0/route-universal.apk", repository));
    }

    @Test
    public void versionCannotEscapeDownloadDirectory() {
        for (String version : new String[]{"", "../1.0.0", "1/2/3", "1.2.3-beta", "1.2", "99999999999.1.0"}) {
            assertThrows(IllegalArgumentException.class, () -> POLICY.validateVersion(version));
        }
        POLICY.validateVersion("0.3.9");
    }

    @Test
    public void versionNormalizationDoesNotHidePrereleaseSuffixes() {
        assertEquals("0.3.9", POLICY.normalizeVersion("v0.3.9"));
        assertEquals("0.3.9-beta", POLICY.normalizeVersion("0.3.9-beta"));
        assertThrows(IllegalArgumentException.class, () -> POLICY.validateVersion(POLICY.normalizeVersion("v0.3.9-beta")));
    }

    private static int rank(String name, List<String> abis) {
        Integer rank = POLICY.assetRank(name, abis);
        return rank == null ? Integer.MAX_VALUE : rank;
    }

    private static void assertThrows(Class<? extends Throwable> type, Runnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) return;
            throw new AssertionError("Expected " + type.getName() + " but got " + error, error);
        }
        throw new AssertionError("Expected " + type.getName());
    }
}
