/**
 * The voice and music models Retween can use, and which vendor serves each.
 *
 * ElevenLabs models are named the way ElevenLabs names them (`eleven_multilingual_v2`)
 * and are called directly. Anything named `vendor/model` is an OpenRouter model
 * (`hexgrad/kokoro-82m`); OpenRouter lists every speech model it has, and any of
 * them works, but these are the ones worth suggesting. Prices are per 1,000
 * characters of narration, checked 2026-11-18.
 */

export const isOpenRouterModel = (modelId: string) => modelId.includes("/");

export interface VoiceModel {
	id: string;
	label: string;
	/** A voice to fall back on when the brand's voice belongs to another vendor. */
	defaultVoice?: string;
	usdPer1kCharacters?: number;
}

/** ElevenLabs narration models, cheapest first. Flash and Turbo cost half as much per character. */
export const ELEVENLABS_VOICE_MODELS: VoiceModel[] = [
	{ id: "eleven_flash_v2_5", label: "ElevenLabs Flash v2.5 (half price, fastest)", usdPer1kCharacters: 0.04 },
	{ id: "eleven_turbo_v2_5", label: "ElevenLabs Turbo v2.5 (half price)", usdPer1kCharacters: 0.04 },
	{ id: "eleven_multilingual_v2", label: "ElevenLabs Multilingual v2 (default)", usdPer1kCharacters: 0.08 },
	{ id: "eleven_v3", label: "ElevenLabs v3 (most expressive)", usdPer1kCharacters: 0.08 },
];

/** Cheaper narration through OpenRouter. voice.list with `model` gives each one's voices. */
export const OPENROUTER_VOICE_MODELS: VoiceModel[] = [
	{ id: "hexgrad/kokoro-82m", label: "Kokoro 82M via OpenRouter (cheapest, clear English narration)", defaultVoice: "af_heart", usdPer1kCharacters: 0.00062 },
	{ id: "google/gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS via OpenRouter (natural, follows direction)", defaultVoice: "Kore" },
	{ id: "mistralai/voxtral-mini-tts-3-0", label: "Voxtral Mini TTS via OpenRouter (emotion variants per voice)", defaultVoice: "en_paul_neutral", usdPer1kCharacters: 0.013 },
	{ id: "deepgram/aura-2", label: "Deepgram Aura 2 via OpenRouter", defaultVoice: "aura-2-thalia-en", usdPer1kCharacters: 0.03 },
	{ id: "minimax/speech-2.8-turbo", label: "MiniMax Speech 2.8 Turbo via OpenRouter", defaultVoice: "English_expressive_narrator", usdPer1kCharacters: 0.06 },
];

export const VOICE_MODELS: VoiceModel[] = [...ELEVENLABS_VOICE_MODELS, ...OPENROUTER_VOICE_MODELS];

export const MUSIC_MODELS = [
	{ id: "elevenlabs", label: "ElevenLabs Music (default): sized to the video, 10 s–5 min, about $0.15 a minute" },
	{ id: "google/lyria-3-pro-preview", label: "Lyria 3 Pro via OpenRouter: a full piece for $0.08; its length follows the prompt, and it loops under longer videos" },
	{ id: "google/lyria-3-clip-preview", label: "Lyria 3 Clip via OpenRouter: a 30 s clip for $0.04, looped under the video" },
] as const;
export type MusicModel = (typeof MUSIC_MODELS)[number]["id"];
export const MUSIC_MODEL_IDS = ["elevenlabs", "google/lyria-3-pro-preview", "google/lyria-3-clip-preview"] as const satisfies readonly MusicModel[];

/** Online platforms play speech-led video at about -14 LUFS; exports are levelled to this unless the brand says otherwise. */
export const DEFAULT_MASTER_LUFS = -14;
/** Highest true peak an export may reach after levelling, in dBTP (headroom for lossy encoders). */
export const MASTER_TRUE_PEAK = -1;

/** The loudness an export should be levelled to, or null to leave the mix alone. */
export function masterLoudness(setting: number | "off" | undefined): { lufs: number; truePeak: number } | null {
	if (setting === "off") return null;
	return { lufs: setting ?? DEFAULT_MASTER_LUFS, truePeak: MASTER_TRUE_PEAK };
}
