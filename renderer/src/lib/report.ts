/**
 * Prefix of the console line a FitBox writes when it had to shrink its
 * content. The renderer server collects these from stills and contact sheets
 * so an agent can be told "scene 4's text was shrunk to 55% in 9:16" without
 * looking. Kept free of React so the server can import it.
 */
export const FIT_REPORT_PREFIX = "[retween-fit] ";

/** `probe` tags the copy of the video (a contact-sheet tile); `box` names the text box, e.g. `intro/text`. */
export type FitReport = { probe?: string; box: string; scale: number; squash: number };
