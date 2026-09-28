# Your own pictures behind the puzzle

The jigsaw ships with drawn artwork in `public/pictures.js`. You can put your own images
behind it instead, generated on your own machine, and nothing leaves the box: the files
are read off the disk, encoded, and written into the site's data directory.

This is the setup for doing that on the card in this machine.

---

## The card

`nvidia-smi` reports an **RTX 4080, 16GB**. That is comfortably enough for:

| Model | VRAM | Speed on a 4080 | Notes |
|---|---|---|---|
| SDXL 1.0 | ~7GB | 3–5s at 1024×1024 | fast, huge community, weakest at prompts |
| SDXL + a fine-tune | ~7GB | same | where the style actually comes from |
| Flux.1-dev (fp8) | ~12GB | 15–25s | much better at following a prompt |
| Flux.1-schnell (fp8) | ~12GB | 3–6s | four steps, a little coarser |

16GB means you never have to think about `--lowvram`. Flux fp8 fits with room to spare.

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
with a background — a room, a street, a patterned surface — is much better.

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

**Real people.** Generating likenesses of actual people — a celebrity, someone you know —
and putting them on a gambling site is a problem whatever the model will happily produce.
Keep it to invented people.

**Where it is shown.** This is a puzzle you stake money on, and in several jurisdictions
what a gambling site displays is regulated alongside the gambling itself. Worth checking
against wherever you end up licensing, rather than after.
