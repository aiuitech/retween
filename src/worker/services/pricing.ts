/**
 * Our rates with each vendor, in US dollars. Used only where a vendor does not
 * report the charge for a request itself (OpenRouter does; fal does through its
 * pricing API). People are billed cost × markup from the usage ledger, so keep
 * these in line with what the vendors actually invoice us. Checked 2026-11-17.
 *
 * Included free allowances (R2's 10 GB, containers' monthly vCPU/GiB hours) are
 * ignored: each account is charged the marginal rate.
 */

/**
 * ElevenLabs API pricing (https://elevenlabs.io/pricing/api), billed in dollars:
 * speech per 1,000 characters by model, music per minute generated.
 * Sound effects are listed per minute but the FAQ also says "per generation";
 * per minute is used.
 */
export const ELEVENLABS = {
	speechUsdPer1kCharacters(modelId: string): number {
		return /flash|turbo/i.test(modelId) ? 0.04 : 0.08;
	},
	musicUsdPerMinute: 0.15,
	sfxUsdPerMinute: 0.12,
};

/** fal list prices, used when its pricing API cannot be reached or the request reported no billable units. */
export const FAL_LIST_USD: Record<string, number> = {
	"fal-ai/birefnet/v2": 0.003,
	"fal-ai/recraft/v4/text-to-vector": 0.08,
	"fal-ai/recraft/v4/pro/text-to-vector": 0.3,
};

/** OpenRouter per-second clip prices, used only when a finished job does not report its cost. */
export const OPENROUTER_CLIP_USD_PER_SECOND: Record<string, number> = { "360p": 0.023172, "720p": 0.069504, "1080p": 0.104256 };

/**
 * Cloudflare Containers (https://developers.cloudflare.com/containers/pricing/), billed per 10 ms while running.
 * Memory and disk are billed as provisioned. CPU is billed on active use, which the Worker cannot see, so a run
 * is first charged as if every vCPU were busy throughout (an upper bound), then corrected overnight from
 * Cloudflare's own usage analytics when the analytics token is set (services/reconcile.ts).
 */
export const CONTAINER_INSTANCE_TYPE = "standard-4";
const CONTAINER = {
	vcpu: 4,
	memoryGiB: 12,
	diskGB: 20,
	usdPerVcpuSecond: 0.00002,
	usdPerGiBSecond: 0.0000025,
	usdPerGBSecondDisk: 0.00000007,
};
/** What Cloudflare bills for measured container usage (from its analytics: CPU seconds and allocated byte-seconds). */
export const containerUsdFromUsage = (usage: { cpuTimeSec: number; allocatedMemory: number; allocatedDisk: number }) =>
	usage.cpuTimeSec * CONTAINER.usdPerVcpuSecond +
	(usage.allocatedMemory / 2 ** 30) * CONTAINER.usdPerGiBSecond +
	(usage.allocatedDisk / 1e9) * CONTAINER.usdPerGBSecondDisk;
export const containerUsdPerSecond = () =>
	CONTAINER.vcpu * CONTAINER.usdPerVcpuSecond + CONTAINER.memoryGiB * CONTAINER.usdPerGiBSecond + CONTAINER.diskGB * CONTAINER.usdPerGBSecondDisk;

/** R2 Standard storage (https://developers.cloudflare.com/r2/pricing/). Operations are a rounding error and are not charged. */
export const R2_USD_PER_GB_MONTH = 0.015;
