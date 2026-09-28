# Your own pictures behind the puzzle

The jigsaw ships with drawn artwork in `public/pictures.js`. You can put your own images
behind it instead, generated on your own machine, and nothing leaves the box: the files
are read off the disk, encoded, and written into the site's data directory.

This is the setup for doing that on the card in this machine.

---

## The card

`nvidia-smi` reports an **RTX 4080, 16GB**. Nothing below will trouble it, and you never
have to think about `--lowvram`.

| Model | VRAM | Speed on a 4080 | Notes |
|---|---|---|---|
| Illustrious XL / NoobAI-XL | ~7GB | 3–5s at 1024×1024 | best open anime models, tag prompts |
| Pony Diffusion V6 XL | ~7GB | 3–5s | strong characters, needs its score_ prefix |
| Animagine XL | ~7GB | 3–5s | cleaner, tamer, good linework |
| SDXL 1.0 base | ~7GB | 3–5s | photographic; poor at anime |
| Flux.1-dev (fp8) | ~12GB | 15–25s | best prompt-following, weak at anime style |

**For anime, use an anime checkpoint.** SDXL base and Flux are both trained mostly on
photographs and produce a muddy half-illustrated look however you prompt them. The
anime-specific SDXL fine-tunes above are the same architecture and the same speed, and the
difference in output is not subtle. Illustrious or NoobAI is the sensible default today.

They all need a VAE alongside the checkpoint (`sdxl_vae.safetensors`), or colours come out
washed and grey.

## What to install

**ComfyUI** is the one to use here. It is a portable download rather than an install, it
batches without fuss, and batching is what you want — a puzzle pool wants fifty pictures,
not one.

1. Get the portable Windows build from the ComfyUI releases page.
2. Unzip it somewhere with room; the models are several GB each.
3. Put the model file in `ComfyUI/models/checkpoints/`.
4. Run `run_nvidia_gpu.bat`.

A1111 or Forge will do the same job with a friendlier interface if you prefer one.

## Output settings that matter here

This is the part that will waste your time if nobody tells you, so:

- **Save as JPEG, quality 85–90.** Not PNG. A 900×900 PNG off the generator is commonly
  1.5–2MB and the importer will refuse it. The same image as JPEG is 150–400KB.
- **1024px on the long edge** is plenty. The puzzle scales it to the board.
- **Square** suits the board best. 1024×1024.

Why the limit exists: the site runs under a Content-Security-Policy that forbids remote
images, so every picture is inlined into the page as a data URI and sent with the round. A
4MB photograph is a 4MB page. The cap is 900KB per picture and 12MB in total, and it is
there to stop the puzzle becoming unusable on a phone.

## What makes a good jigsaw picture

Not the same as what makes a good picture.

- **Detail everywhere.** A jigsaw is solved by matching neighbouring pieces, so a large
  flat area — an empty sky, a plain wall, a soft-focus background — is a region of
  identical pieces and simply tedious. Busy is good.
- **Contrast and colour variety** across the whole frame, not just in the middle.
- **Avoid heavy vignetting and dark corners**, for the same reason.
- **No text.** Generators produce mangled lettering and it looks like a fault.

A portrait on a plain backdrop is a weak jigsaw however good the portrait is. Something
with a background — a room, a street, a patterned surface — is much better. For anime
checkpoints this is a prompting problem with a specific fix; see the next section.

## Prompting an anime checkpoint

These do not want a sentence. They are trained on danbooru tags, so a prompt is a
comma-separated list, roughly: quality tags, then subject, then clothing, then setting,
then framing.

```
masterpiece, best quality, highly detailed,
1girl, solo, adult woman, long black hair, red eyes,
lingerie, lace, garter belt,
detailed background, hotel room at night, neon through the window, patterned wallpaper,
cowboy shot, looking at viewer, cinematic lighting
```

Pony-based checkpoints additionally want `score_9, score_8_up, score_7_up` at the front;
the others do not and it makes them worse.

A negative prompt does real work on these models:

```
lowres, worst quality, low quality, jpeg artifacts, bad anatomy, bad hands,
missing fingers, extra digits, watermark, signature, username, text,
simple background, white background
```

### Two tags that matter more than the rest

**`detailed background`, and never `simple background`.** Anime checkpoints default hard
to a plain or gradient backdrop, and a plain backdrop is the worst possible jigsaw: a
large field of identical pieces. This single tag is the difference between a puzzle that
is fun and one that is a chore. Name an actual room or street and it will draw one.

**`adult woman`, and the age negatives.** Anime models skew young by default, and
underwear plus a childlike face is a serious legal problem in most of the world whatever
was intended. Put `adult woman, mature female` in the prompt and
`child, loli, petite, flat chest, young` in the negative, and pick a checkpoint that is
not tuned that way — Animagine and Illustrious are fine, some community merges are not.
Look at what comes out and bin anything ambiguous. This is not a style note.

## Importing

```bash
node tools/puzzle-import.js <folder>          # see what would be imported
node tools/puzzle-import.js <folder> --yes    # write it
node tools/puzzle-import.js --clear           # remove every imported picture
```

Then **restart the server**. The pictures are held in memory, so until you do, the site
serves the previous set — including after `--clear`.

The tool checks that a file really is the image its extension claims, that it is under the
size limit, and nothing else. What goes in the folder is your decision and it does not
look at it.

The filename becomes the key, so re-importing the same file keeps its place in the pool
rather than adding a duplicate.

## Two things worth keeping in mind

**Real people.** Invented characters are fine. Likenesses of actual people — a
celebrity, someone you know — are a problem whatever the model will happily produce, and
that holds for anime styling of a real person too. Keep it to characters who are nobody.

**Where it is shown.** This is a puzzle you stake money on, and in several jurisdictions
what a gambling site displays is regulated alongside the gambling itself. Worth checking
against wherever you end up licensing, rather than after.
