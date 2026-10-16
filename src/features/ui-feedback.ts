import { useCallback, useEffect, useState } from "react";
import { saveJson } from "./store";

export type UiPreferences = {
  soundEnabled: boolean;
  soundVolume: number;
  motionEnabled: boolean;
};

const STORAGE_KEY = "route-ui-preferences";
const DEFAULTS: UiPreferences = {
  soundEnabled: true,
  soundVolume: 0.45,
  motionEnabled: true,
};

type SoundName = "click" | "switch" | "success" | "error";

export function loadUiPreferences(): UiPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<UiPreferences> | null;
    return {
      soundEnabled: parsed?.soundEnabled !== false,
      soundVolume: typeof parsed?.soundVolume === "number"
        ? Math.min(1, Math.max(0, parsed.soundVolume))
        : DEFAULTS.soundVolume,
      motionEnabled: parsed?.motionEnabled !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveUiPreferences(value: UiPreferences) {
  saveJson(STORAGE_KEY, value);
}

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  audioContext ??= new AudioCtor();
  return audioContext;
}

export function playUiSound(name: SoundName, volume: number) {
  const context = getAudioContext();
  if (!context || volume <= 0) return;
  try {
    if (context.state === "suspended") void context.resume().catch(() => {});
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(Math.min(0.12, volume * 0.12), now);
    master.connect(context.destination);
    const notes: Record<SoundName, [number, number, number]> = {
      click: [520, 0.045, 0],
      switch: [620, 0.07, 0],
      success: [660, 0.08, 0.12],
      error: [180, 0.12, 0],
    };
    const [frequency, duration, secondOffset] = notes[name];
    const oscillator = context.createOscillator();
    oscillator.type = name === "error" ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.connect(master);
    oscillator.start(now);
    oscillator.stop(now + duration);
    master.gain.exponentialRampToValueAtTime(0.001, now + duration);
    if (secondOffset) {
      const second = context.createOscillator();
      second.type = "triangle";
      second.frequency.setValueAtTime(frequency * 1.25, now + secondOffset);
      second.connect(master);
      second.start(now + secondOffset);
      second.stop(now + secondOffset + duration);
    }
  } catch {
    // 部分 WebView 不支持 Web Audio 时静默降级，不影响功能。
  }
}

export function useUiFeedback() {
  const [preferences, setPreferences] = useState<UiPreferences>(() => loadUiPreferences());

  useEffect(() => saveUiPreferences(preferences), [preferences]);

  const updatePreferences = useCallback((patch: Partial<UiPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const play = useCallback((name: SoundName) => {
    if (preferences.soundEnabled) playUiSound(name, preferences.soundVolume);
  }, [preferences.soundEnabled, preferences.soundVolume]);

  return { preferences, updatePreferences, play };
}
