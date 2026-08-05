# Plan: Stage HAAS classic-control manuals into /home/holla/aaSender/reference/

## Status

Research is **complete**. All candidate PDFs were located, downloaded, and verified
in the session scratchpad. Because this session is in plan mode, nothing has been
written into `/home/holla/aaSender/`. The only remaining step is a file copy — no
re-download is needed.

Scratchpad staging directory:
`/tmp/claude-1000/-home-holla-aaSender/9406b8dc-5a1d-4e56-bcaf-d2960a688a40/scratchpad/`

## Execution step (single command)

```bash
mkdir -p /home/holla/aaSender/reference
cd /tmp/claude-1000/-home-holla-aaSender/9406b8dc-5a1d-4e56-bcaf-d2960a688a40/scratchpad
cp ufl-vf2.pdf    /home/holla/aaSender/reference/haas-96-8000-revL-2005-vf-operator.pdf
cp mill-2004.pdf  /home/holla/aaSender/reference/haas-96-8000-2004-mill-operator.pdf
cp mill-2009.pdf  /home/holla/aaSender/reference/haas-96-8000-revY-2009-mill-operator.pdf
cp mill-2012.pdf  /home/holla/aaSender/reference/haas-96-8000-revAP-2012-mill-operator.pdf
cp mill-2014.pdf  /home/holla/aaSender/reference/haas-96-8200-2014-mill-operator.pdf
```

Nothing else in `/home/holla/aaSender` is touched.

## Verified source URLs (all HTTP 200, `content-type: application/pdf`)

| Local name | Source URL |
|---|---|
| `ufl-vf2.pdf` | `https://web.mae.ufl.edu/designlab/TA/Manuals/Haas%20VF-2%20Operator%20Manual.pdf` |
| `mill-2004.pdf` | `https://www.haascnc.com/content/dam/haascnc/en/service/manual/operator/english---mill-operator's-manual---2004.pdf` |
| `mill-2009.pdf` | `https://www.haascnc.com/content/dam/haascnc/en/service/manual/operator/english---mill-operator's-manual---2009.pdf` |
| `mill-2012.pdf` | `https://www.haascnc.com/content/dam/haascnc/en/service/manual/operator/english---mill-operator's-manual---2012.pdf` |
| `mill-2014.pdf` | `https://www.haascnc.com/content/dam/haascnc/en/service/manual/operator/english---mill-operator's-manual---2014.pdf` |

All are free public downloads from Haas Automation's own CDN (plus one university
mirror). No paywall or login was involved.

The haascnc.com archive also serves `...---mill-operator's-manual---YYYY.pdf` for
2005, 2006, 2007, 2008, 2010, and 2011 (2013 returns 404), and
`english---vf-series-operators-manual---1995.pdf` (43 MB, scanned, **not** OCR'd).

## Verification performed

- `file` reports `PDF document` for every file; sizes 2–43 MB; no HTML error pages.
- `pdfinfo` page counts confirmed (see report).
- `pdftotext -layout` extracted successfully from all except the 1995 scan.
- `pdftoppm -r 400` confirmed the keypad/display artwork is **vector**, not raster —
  it renders crisp at arbitrary DPI (3400×4400 px at 400 DPI).

## Extraction recipe for the web UI work

```bash
# Classic (abbreviated-label) keypad, the exact panel being recreated:
pdftoppm -f 18 -l 18 -r 600 -png ufl-vf2.pdf keypad-classic
# Late-classic keypad with spelled-out labels + all 8 groups numbered:
pdftoppm -f 55 -l 55 -r 600 -png mill-2014.pdf keypad-late
# Control display pane layout with 13 numbered callouts:
pdftoppm -f 65 -l 65 -r 600 -png mill-2014.pdf display-layout
```
