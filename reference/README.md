# Reference material

The control layout in this project is transcribed from the **HAAS Mill Operator's
Manual, 2014 (96-8200)**. That manual is copyright Haas Automation, Inc., so it is
**not committed to this repository** — `.gitignore` keeps it out. Fetch your own
copy and drop it in this directory:

```
curl -o "english---mill-operator's-manual---2014.pdf" \
  "https://www.haascnc.com/content/dam/haascnc/en/service/manual/operator/english---mill-operator's-manual---2014.pdf"
```

The same URL pattern works for 2004–2012 (2013 is a 404). Note the apostrophe in
`operator's` — quote the URL.

## Which pages matter

PDF page = printed page + 20.

| PDF page | What |
|---|---|
| 52–53 | The pendant |
| **55** | Figure F2.26 — the full keyboard, all eight key groups labelled |
| 56–64 | Every key group in detail, key by key |
| **65** | Figure F2.27 — the display layout, thirteen numbered panes |
| 66 | The mode bar and table T2.11 — the three modes |
| 357–394 | Settings |

## Rendering the artwork

The manual's figures are vector, so they render cleanly at any size. These are the
three worth having on screen while working on the UI:

```
pdftoppm -f 55 -l 55 -r 600 -png english---mill-*.pdf keypad
pdftoppm -f 65 -l 65 -r 600 -png english---mill-*.pdf display
pdftoppm -f 52 -l 53 -r 600 -png english---mill-*.pdf pendant
```

Output lands in `reference/art/`, which is also gitignored — it is derived from the
same copyrighted source.

## Era matters

The 2004–2009 manuals document the older full-screen green display. The 2012 and
2014 manuals document the later multi-pane control with the Setup/Edit/Operation
mode bar — that is the one in `images/haas1.jpg`, and the one this project copies.
