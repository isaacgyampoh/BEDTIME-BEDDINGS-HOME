/**
 * The browser's own speech recognition, used for the press-to-talk fallback
 * when a live voice conversation is not available.
 *
 * Kept out of the component so the component file exports only a component —
 * mixing the two breaks fast refresh during development.
 *
 * Only Chrome and Edge implement this, which is why it is the fallback and not
 * the main path: real speech-to-speech (lib/realtime.js) needs only WebRTC and
 * therefore works on iPhones, iPads, Safari and Firefox as well.
 */
export const SpeechRecognitionAPI =
  typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null

export const voiceSupported = () => !!SpeechRecognitionAPI
