/** Shared with LUNA's genres.c: bounded ASCII, one primary genre. */
export const UNCATEGORIZED = "Uncategorized";
export const GENRE_LABELS = [
  "Action", "Adventure", "Fighting", "Horror", "Party", "Platformer",
  "Puzzle", "Racing", "Rhythm", "RPG", "Shooter", "Simulation", "Sports",
  "Strategy", "Other", UNCATEGORIZED,
] as const;

const aliases: Record<string, string> = {
  rpg: "RPG", "role playing": "RPG", "role playing game": "RPG",
  "role playing games": "RPG", "action rpg": "RPG", jrpg: "RPG",
  racing: "Racing", driving: "Racing", race: "Racing", sport: "Sports", sports: "Sports",
  shooting: "Shooter", shooter: "Shooter", fps: "Shooter",
  "first person shooter": "Shooter", "third person shooter": "Shooter",
  platform: "Platformer", platformer: "Platformer", platforming: "Platformer",
  puzzle: "Puzzle", fighting: "Fighting", fight: "Fighting", action: "Action",
  adventure: "Adventure", strategy: "Strategy", simulation: "Simulation", simulator: "Simulation",
  music: "Rhythm", rhythm: "Rhythm", "music and rhythm": "Rhythm",
  horror: "Horror", "survival horror": "Horror", party: "Party", other: "Other",
  unknown: UNCATEGORIZED, unclassified: UNCATEGORIZED, uncategorized: UNCATEGORIZED,
  "n a": UNCATEGORIZED, n: UNCATEGORIZED,
};

export function normalizeGenre(value?: string): string {
  const primary = (value ?? "").split(/[/,;|]/, 1)[0];
  if (/[^\x00-\x7f]/.test(primary)) return UNCATEGORIZED;
  const text = primary
    .replace(/[-_\s]+/g, " ").trim().toLowerCase();
  if (!text || text.length > 47 || /[^\x20-\x7e]/.test(text)) return UNCATEGORIZED;
  return Object.prototype.hasOwnProperty.call(aliases, text) ? aliases[text] :
    text.replace(/(^| )[a-z]/g, (letter) => letter.toUpperCase());
}

export function normalizeGameId(value: string): string {
  const id = value.trim().toUpperCase();
  if (!/^[A-Z]{4}_\d{3}\.\d{2}$/.test(id)) throw new Error("Invalid game ID");
  return id;
}

export function genreFromCfg(entries: Record<string, string>): string {
  // Last matching field wins, matching the PS2 parser.
  let genre = UNCATEGORIZED;
  for (const [key, value] of Object.entries(entries)) {
    if (key.replace(/^#/, "").toLowerCase() === "genre") genre = normalizeGenre(value);
  }
  return genre;
}
