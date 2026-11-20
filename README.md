# gt_images

Shared image assets for the GoTech apps, served from Cloudinary.

## Using an image

Every file keeps its repo path under one base URL:

```
https://res.cloudinary.com/gin8nemo/image/upload/gt_images/<path>
```

For example, `brand_logos/banks/access_bank_nigeria.webp` is at
`https://res.cloudinary.com/gin8nemo/image/upload/gt_images/brand_logos/banks/access_bank_nigeria.webp`.

To resize or recompress, put Cloudinary transformations after `upload/` and
add a `v1/` segment before `gt_images/`, e.g.
`.../image/upload/w_96,q_auto/v1/gt_images/Bill.webp`. Without `v1/`,
Cloudinary parses `gt_images` as a transformation and returns 400.
`.../image/upload/v1/gt_images/<path>` serves the original too, so it's the
safer base URL for code that may add transformations later.

The old `raw.githubusercontent.com/gofinancials/gt_images/refs/heads/main/...`
URLs still work, because released app builds use them. Don't delete or
rename files that a shipped build may load.

## Adding or replacing an image

Commit the `.webp` and merge to `main`. The
[Cloudinary sync workflow](.github/workflows/cloudinary-sync.yml) uploads
changed files to the same path.

To upload by hand, put `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and
`CLOUDINARY_API_SECRET` in `.env` (git-ignored), then:

```bash
node scripts/cloudinary_sync.mjs                  # every tracked .webp
node scripts/cloudinary_sync.mjs path/to/a.webp   # just these files
node scripts/cloudinary_sync.mjs --verify         # check Cloudinary matches git
```
