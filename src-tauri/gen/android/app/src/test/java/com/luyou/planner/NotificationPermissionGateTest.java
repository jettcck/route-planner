package com.luyou.planner;

import static org.junit.Assert.assertEquals;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class NotificationPermissionGateTest {
    @Test
    public void concurrentPluginsCannotInterruptThePermissionDialog() throws Exception {
        NotificationPermissionGate gate = new NotificationPermissionGate();
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger requests = new AtomicInteger();
        Thread[] plugins = new Thread[2];
        for (int i = 0; i < plugins.length; i++) {
            plugins[i] = new Thread(() -> {
                try { start.await(); } catch (InterruptedException e) { throw new AssertionError(e); }
                if (gate.begin(false) == NotificationPermissionGate.Action.REQUEST) requests.incrementAndGet();
            });
            plugins[i].start();
        }
        start.countDown();
        for (Thread plugin : plugins) plugin.join();
        assertEquals(1, requests.get());
        // The second plugin sees the persisted requested flag but must wait,
        // rather than launching settings over the still-active system dialog.
        assertEquals(NotificationPermissionGate.Action.WAIT, gate.begin(true));
    }

    @Test
    public void permissionResultEnablesRecoveryAndFailedLaunchCanRetry() {
        NotificationPermissionGate gate = new NotificationPermissionGate();
        assertEquals(NotificationPermissionGate.Action.REQUEST, gate.begin(false));
        gate.finish();
        assertEquals(NotificationPermissionGate.Action.SETTINGS, gate.begin(true));
        assertEquals(NotificationPermissionGate.Action.REQUEST, gate.begin(false));
        gate.finish();
        assertEquals(NotificationPermissionGate.Action.REQUEST, gate.begin(false));
    }
}
