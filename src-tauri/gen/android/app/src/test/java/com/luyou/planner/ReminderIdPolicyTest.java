package com.luyou.planner;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.HashSet;
import org.junit.Test;

public class ReminderIdPolicyTest {
    @Test
    public void knownStringHashCollisionGetsDifferentReminderIds() {
        long atMillis = 1791417600000L;
        assertNotEquals(ReminderIdPolicy.INSTANCE.id("Aa", atMillis), ReminderIdPolicy.INSTANCE.id("BB", atMillis));
    }

    @Test
    public void sameReminderIsStable() {
        assertEquals(ReminderIdPolicy.INSTANCE.id("出发", 1791417600000L),
            ReminderIdPolicy.INSTANCE.id("出发", 1791417600000L));
    }

    @Test
    public void occupiedIdsCannotOverwriteAnotherStoredReminder() {
        int preferred = ReminderIdPolicy.INSTANCE.id("出发", 1791417600000L);
        HashSet<Integer> occupied = new HashSet<>(Arrays.asList(preferred,
            preferred == Integer.MAX_VALUE ? 1 : preferred + 1));
        int selected = ReminderIdPolicy.INSTANCE.availableId("出发", 1791417600000L, occupied);
        org.junit.Assert.assertTrue(selected > 0);
        org.junit.Assert.assertFalse(occupied.contains(selected));
    }

    @Test
    public void appOwnedNotificationIdsAreReserved() {
        for (long atMillis = 1791417600000L; atMillis < 1791417600010L; atMillis++) {
            int selected = ReminderIdPolicy.INSTANCE.availableId("reminder-" + atMillis, atMillis,
                new HashSet<>());
            assertNotEquals(7812, selected);
            assertNotEquals(7814, selected);
        }
    }
}
