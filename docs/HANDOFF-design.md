# Interface design: mockups and rules

Current as of 8 September 2026. This note is about how the product LOOKS. Detection,
measurements and the model are in the other handoffs; not a word about them here.

Mockup: `docs/design/mockups.html` — a self-contained page, opens with a double click.
View on the web: <https://claude.ai/code/artifact/39da389f-2d3f-4046-adea-677fff3c69e3>

---

## How to read the file without burning context

The file is 250 KB, and 180 of them are the project's two marks embedded as base64. There is
no point reading it whole. Make yourself a clean copy and work with it:

```bash
python3 -c "import re,sys; s=open('docs/design/mockups.html',encoding='utf-8').read(); open('/tmp/mockups-readable.html','w',encoding='utf-8').write(re.sub(r'data:image/webp;base64,[A-Za-z0-9+/=]+','@IMG@',s))"
```

About 70 KB remain: markup, styles and rationale — everything you need for the work. Make your
edits in `docs/design/mockups.html`, though, not in the copy.

---

## Single-owner rule

**One chat edits the mockup at a time. The others read.**

Publishing to an artifact that this chat did not read last is rejected: the server returns
the fresh version and demands the edits be merged. If two chats edit at once, the second one
loses the first one's work or gets a conflict. Agree on who leads — and the others send
remarks in words.

To update the published page from another chat:

1. `Artifact` with `action: "read"` and the URL above — otherwise publishing is rejected;
2. edits in `docs/design/mockups.html`;
3. `Artifact` with the same `url` — the URL and version history are kept.

---

## What must not be changed without asking

| What | Where from | Why |
|---|---|---|
| Colors, radii, fonts | `src/shared/ui/index.css` | the mockup is built on product tokens; a mismatch here means the mockup lies |
| Screen copy | `src/shared/i18n/locales/ru.json` | «Дропни хайлайт», «Раунд не найден», «Залутать шедевр» — this is the service's voice, and it already works |
| Orange as the only accent | same place | one primary button per screen; every other action is not orange |
| The chicken on error pages | `public/roasted-chicken.webp` | it is the service's mark; a large code number does not replace it |
| Crosshair green `#00ff00` | upload zone | the crosshair only, nowhere else |

The only added color is the CT-side blue `#5b9bd5` named `--info`: hints, fallback links,
the second layer of the track. **Never a button** — it would outweigh the primary one.

---

## What is decided, by mockup section

Numbering matches the page's sections.

| No. | Section | Decision |
|---|---|---|
| — | General | A four-step scale on every screen: Clip · **Review** · Sound · Done |
| — | General | Content area on wide screens is **768 px**. At that width the arsenal goes in three columns, the video stage is capped at 340 px, prose at 62 characters per line |
| 01 | Upload | Limits (formats, 15 MB, 60 s) sit under the drop zone, not after a rejection |
| 02 | Analysis | Phases are named by result, not by method; the found count grows as it goes; cancel is always available. The last phase is "putting sound on the shots": by the end of analysis the result is already voiced |
| 03 | Review | Right after analysis the shots are replaced with a short default meme. The first action is to listen, not to edit |
| 03 | Review | Listen to the whole clip, don't jump between markers: stepping cannot show misses by construction, and every fourth or fifth shot is a miss |
| 03 | Review | The screen asks "Does it hit?" and offers two answers. Tools are hidden until the answer is "no" |
| 03 | Review | The "next shot" button is a skip, not a check |
| 03 | Markers | The arrow step is ONE and short. There is no long one: a marker is caught by ear, precision is not needed |
| 03 | Markers | The track has two layers: grey is the clip's sound, blue is what the system heard. Peaks coincide with markers |
| 03b | Edit | Opens only on "no, fix it". Stepping through markers with buttons that play, zoom is set automatically on each jump |
| 03b | Edit | A double click distinguishes the target, not the action: hit a marker — removed, missed — placed. Nudge with arrows, one step |
| 04 | Sound | The step turns from "pick" into "swap": a meme is already in. Three sources as tabs, the arsenal visible right away; each sound has its own duration |
| 05 | Done | A summary in three numbers; the slider is labelled with its effect ("the shot's tail is audible"), not its mechanism |
| 06 | Menu | On wide screens a row in the header, on narrow a panel from the top, 52 px items |
| 06 | Footer | A third column, «Соцсети» / "Social": YouTube and TikTok, icon plus name, new tab. Kept apart from «Обратная связь» — social links lead off the site, feedback leads into the form. The columns are `auto-fit, minmax(118px, 1fr)`, so at 300 px they stay two wide and the social one drops to a second row. Links: `youtube.com/@pewpew_baby`, `tiktok.com/@pewpew.baby` |
| 07 | How it works | Four steps are numbered: the order carries meaning. The limits are the same as in the upload zone |
| 08 | FAQ | Collapsed, the first one open; expands on the whole row; a way out to feedback at the bottom |
| 09 | Feedback | A popup over the current screen, the topic as a list, the form adapts to the topic. Submitted to Web3Forms from the browser, the response is read. Email is optional everywhere. The first iteration has no technical context: only topic, text, link and email |
| 10 | Errors | The chicken plus the code in the border color. On 404 there is one exit — home; on 500 "Try again" comes first. "Sent" moved into the feedback popup |

The key argument section 03 rests on: the replacement is not layered on top, it
**mutes the original** around the marker (`spliceReplacementAudio`: mute plus ducking). So a
correct marker sounds like a clean meme, and a shifted one like "bonk-bang": the real shot
stayed next to the mute. Anyone hears the error, no waveform reading required. "Listen,
don't look" is built on this.

The second argument is scale. On the overview track a second takes 32 pixels: a 50 ms offset
is one and a half pixels, and a burst of three shots is six. You cannot check it by eye or hit
it with a mouse; in a three-second window the same burst stretches to forty-seven pixels,
which is why editing lives under zoom.

The rationale for every decision is in the mockup itself, to the left of each screen. So is
what did not fit in the table: why undo lives on a separate line, why a marker has no removal
confirmation, why numbers are set in tabular-nums.

---

## What the mockup does not have

These are not unfinished bits but open questions. Before closing any of them — ask.

1. **Narrow screens.** The screens are drawn at 768 px — that is a wide screen. How all of it
   folds on a phone is not shown once. Note: 768 was chosen after comparing with 640, and 640
   is exactly what `WizardLayout.css` has now, i.e. the "leave it as is" option.
2. **The long wait.** Analysis takes about 60% of the clip's length: a minute of clip is
   thirty-six seconds. The "Analysis" screen shows phases and cancel, but how to fill those
   seconds so the tab isn't closed is not decided.
3. **Outro.** An ending with the mark is appended to the exported file. No screen says a word
   about it — the person finds out from the finished video.
4. **English.** Everything is drawn on the Russian strings. The English ones are longer almost
   everywhere, and the first to test that will be a button on a narrow screen.
5. **Which meme is the default.** It must be short with a sharp attack, otherwise a burst of
   five shots smears into mush: 0.9 s on top of a 0.5 s burst is one blob. The mockup has
   Bonk (0.3–0.4 s); the choice of the actual sound is yours.

6. **Restoring a removed marker.** Trash and undo are postponed — removal is irreversible. A
   slip is fixed by another double click, but if the gesture turns out too easy, this is the
   first thing that will have to come back.
7. **Web3Forms limit.** 250 submissions a month for free, with no binding of the key to the
   domain — anyone can use the key from the code. What to do when the limit is hit (pay or put
   up our own proxy) is not decided.

---

## Where to go next

- Screens and rationale — `docs/design/mockups.html`.
- Tokens and the current look — `src/shared/ui/index.css`, `src/features/wizard/WizardLayout.css`.
- Copy — `src/shared/i18n/locales/ru.json` and `en.json`.
- Who owns what in the code — `docs/AGENT_UI.md`.
