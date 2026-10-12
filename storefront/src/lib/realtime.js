/**
 * Speech to speech: the shopper's voice goes to the model, the model's voice
 * comes back. No transcription step in between.
 *
 * Why this and not the browser's speech recognition: recognition only exists in
 * Chrome and Edge, so it left out iPhones, iPads, Safari on a Mac, and Firefox.
 * This path needs only getUserMedia and WebRTC, which every current browser has
 * — so a laptop, a phone or a tablet all behave the same.
 *
 * Verified against the current Realtime API (October 2026):
 *   server  POST /v1/realtime/client_secrets  -> short-lived key (never the shop's own)
 *   browser POST /v1/realtime/calls           -> SDP offer, answer back
 *   tools   session.update declares them; response.done carries function_call
 *           items; the result goes back as a conversation.item.create of type
 *           function_call_output, then response.create makes the model speak it.
 */
import { toolSchemas, INSTRUCTIONS } from './voiceTools.js'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

// A live conversation is billed by the minute, and a forgotten tab would run
// until the browser closed. Sessions end themselves; the shopper can start
// another immediately. Five minutes is far longer than any real shopping turn.
const MAX_SESSION_MS = 5 * 60 * 1000

export const realtimeSupported = () =>
  typeof window !== 'undefined' &&
  typeof RTCPeerConnection !== 'undefined' &&
  !!navigator?.mediaDevices?.getUserMedia

/**
 * Open a session. Returns a handle: { stop, mute, interrupt, sendText }.
 *
 * on: { status(s), transcript(who, text), tool(name, args), error(message) }
 */
export async function startRealtime({ tokenUrl, onEvent = {}, runTool }) {
  const say = (s) => onEvent.status?.(s)
  say('connecting')

  // 1. The short-lived key, minted by our server. The shop's own key never
  //    exists in the browser.
  const res = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const token = await res.json().catch(() => null)
  if (!res.ok || !token?.value) {
    const reason = token?.reason === 'not-configured' ? 'not-configured' : 'token-failed'
    const err = new Error(token?.error || 'Could not start a voice session.')
    err.reason = reason
    throw err
  }

  // 2. The microphone. Asked for only now, when the shopper has tapped to talk.
  let mic
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch (e) {
    const err = new Error('Microphone permission is needed to talk.')
    err.reason = e?.name === 'NotAllowedError' ? 'denied' : 'no-mic'
    throw err
  }

  const pc = new RTCPeerConnection()
  const audioEl = document.createElement('audio')
  audioEl.autoplay = true
  audioEl.setAttribute('playsinline', '')      // iOS plays inline rather than fullscreen
  document.body.appendChild(audioEl)

  let stopped = false
  let capTimer = null
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(capTimer)
    try { mic.getTracks().forEach(t => t.stop()) } catch { /* already stopped */ }
    try { pc.getSenders().forEach(s => s.track && s.track.stop()) } catch { /* gone */ }
    try { dc?.close() } catch { /* gone */ }
    try { pc.close() } catch { /* gone */ }
    try { audioEl.srcObject = null; audioEl.remove() } catch { /* gone */ }
    say('idle')
  }

  pc.ontrack = (e) => { audioEl.srcObject = e.streams[0] }
  pc.addTrack(mic.getTracks()[0], mic)
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && !stopped) {
      onEvent.error?.('The voice connection dropped.')
      stop()
    }
  }

  const dc = pc.createDataChannel('oai-events')
  const send = (obj) => { try { if (dc.readyState === 'open') dc.send(JSON.stringify(obj)) } catch { /* channel gone */ } }

  capTimer = setTimeout(() => {
    if (stopped) return
    onEvent.error?.('The voice session ended after five minutes. Tap the microphone to carry on.')
    stop()
  }, MAX_SESSION_MS)

  dc.addEventListener('open', () => {
    // Declare what the assistant is and the only actions it may take.
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: INSTRUCTIONS,
        tools: toolSchemas,
        tool_choice: 'auto',
      },
    })
    say('listening')
    onEvent.ready?.()
  })

  dc.addEventListener('message', async (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }

    switch (msg.type) {
      case 'input_audio_buffer.speech_started': say('hearing'); break
      case 'input_audio_buffer.speech_stopped': say('thinking'); break
      case 'response.created': say('thinking'); break
      case 'response.output_audio.delta':
      case 'response.audio.delta': say('speaking'); break
      default: break
    }

    // What the shopper said, and what the assistant said — for the transcript.
    if (msg.type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      onEvent.transcript?.('you', msg.transcript)
    }
    if ((msg.type === 'response.output_audio_transcript.done' || msg.type === 'response.audio_transcript.done') && msg.transcript) {
      onEvent.transcript?.('shop', msg.transcript)
    }

    if (msg.type === 'response.done') {
      say('listening')
      const calls = (msg.response?.output || []).filter(o => o.type === 'function_call')
      for (const call of calls) {
        let args = {}
        try { args = JSON.parse(call.arguments || '{}') } catch { /* malformed; tools validate */ }
        onEvent.tool?.(call.name, args)
        let result
        try { result = await runTool(call.name, args) }
        catch (err) { result = { ok: false, error: String(err?.message || err) } }
        send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result ?? {}) },
        })
      }
      // Let the model speak the outcome of whatever it just did.
      if (calls.length) send({ type: 'response.create' })
    }

    if (msg.type === 'error') {
      onEvent.error?.(msg.error?.message || 'The voice service reported a problem.')
    }
  })

  // 3. Offer / answer.
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  const sdpRes = await fetch(CALLS_URL, {
    method: 'POST',
    body: offer.sdp,
    headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
  })
  if (!sdpRes.ok) {
    stop()
    const err = new Error('The voice service refused the connection.')
    err.reason = 'sdp-failed'
    throw err
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() })

  return {
    stop,
    /** Cut the assistant off mid-sentence, the way a person would. */
    interrupt: () => { send({ type: 'response.cancel' }); say('listening') },
    /** Stop sending audio without ending the session. */
    mute: (on) => { try { mic.getAudioTracks().forEach(t => (t.enabled = !on)) } catch { /* gone */ } },
    /** The typed fallback, through the same conversation. */
    sendText: (text) => {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
      send({ type: 'response.create' })
    },
    isOpen: () => !stopped && pc.connectionState !== 'closed',
  }
}
