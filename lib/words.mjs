/**
 * Word lists for Docker-style box names (`dsh_brisk_otter`).
 *
 * Constraints that shaped these lists:
 * - Sandboxie accepts only alphanumerics and `_` in a box name (Start.exe's own
 *   parser: `iswalnum(c) || c === '_'`), so every word is plain lowercase ASCII.
 * - The whole name must stay well inside Sandboxie's 34-wide-character box-name
 *   buffer, so words are short.
 * - 90 x 90 = 8100 first-choice combinations; `boxNameCandidates` walks further
 *   on the rare collision instead of lengthening the name.
 */

export const ADJECTIVES = [
  "able", "amber", "ancient", "arctic", "autumn", "azure", "bald", "beige", "bitter", "bold",
  "bouncy", "brave", "breezy", "bright", "brisk", "bronze", "burly", "busy", "calm", "candid",
  "canny", "cheery", "chilly", "civic", "clever", "cloudy", "cosmic", "cozy", "crimson", "crisp",
  "curious", "dapper", "daring", "dawn", "deft", "dense", "dizzy", "dusty", "eager", "early",
  "earthy", "elated", "electric", "elegant", "ember", "fancy", "fearless", "fleet", "fluffy", "foggy",
  "fond", "frank", "frosty", "gilded", "glad", "glossy", "golden", "graceful", "grand", "grateful",
  "green", "hardy", "hazel", "hearty", "hidden", "honest", "humble", "ivory", "jolly", "jovial",
  "keen", "kindly", "lively", "lucid", "lucky", "lush", "mellow", "merry", "mighty", "misty",
  "modest", "mossy", "nimble", "noble", "olive", "placid", "playful", "plucky", "polar", "polished",
  "proud", "quaint", "quiet", "rapid", "rustic", "sandy", "scarlet", "serene", "sharp", "shiny",
  "silent", "silky", "silver", "sleek", "smooth", "snowy", "sober", "solar", "spry", "steady",
  "sturdy", "sunny", "swift", "tame", "tender", "teal", "tidy", "tiny", "topaz", "tranquil",
  "valiant", "velvet", "vivid", "warm", "wise", "witty", "zesty"
];

export const NOUNS = [
  "acorn", "alder", "anchor", "antler", "arrow", "aspen", "atlas", "badger", "bamboo", "basin",
  "beacon", "beaver", "berry", "birch", "bison", "blossom", "bramble", "brook", "bubble", "cactus",
  "canyon", "cedar", "cello", "cinder", "clover", "cobalt", "comet", "compass", "coral", "cosmos",
  "cotton", "crab", "crane", "crater", "cricket", "crystal", "cypress", "dahlia", "daisy", "dolphin",
  "dragon", "dune", "eagle", "ember", "falcon", "fawn", "fern", "finch", "fjord", "flint",
  "forest", "fossil", "fox", "galaxy", "garden", "gecko", "ginger", "glacier", "gopher", "granite",
  "grove", "gull", "harbor", "hazel", "heron", "hickory", "hollow", "ibis", "indigo", "island",
  "ivy", "jasmine", "jasper", "juniper", "kestrel", "koala", "lantern", "larch", "lark", "laurel",
  "lava", "lemon", "lilac", "lily", "linen", "lotus", "lynx", "magnet", "magnolia", "mango",
  "maple", "marble", "meadow", "mesa", "meteor", "mint", "moth", "mulberry", "nebula", "nectar",
  "nettle", "oasis", "ocean", "olive", "onyx", "orbit", "orchid", "osprey", "otter", "panda",
  "pebble", "pelican", "penguin", "pepper", "petal", "pine", "pixel", "plum", "pollen", "poppy",
  "prairie", "prism", "puffin", "quartz", "quill", "raven", "reef", "ridge", "robin", "rowan",
  "saffron", "sage", "salmon", "sequoia", "shale", "sparrow", "spruce", "summit", "sycamore", "talon",
  "thistle", "thunder", "tiger", "timber", "topaz", "tulip", "tundra", "turtle", "valley", "violet",
  "walnut", "walrus", "willow", "winter", "wren", "yarrow", "zephyr"
];
