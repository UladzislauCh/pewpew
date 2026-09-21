# UI Agent

## Purpose
Improve user experience for labeling, editing, and understanding gunshot detection.

**Key metric:** Usability (subjective) + Performance (objective)  
**Tool:** `pnpm dev` (browser testing)

---

## Domain & Scope

### You Own
```
src/
├─ app/                # entry point and site shell
│  ├─ main.tsx         # Entry point
│  ├─ App.tsx          # Main routing
│  ├─ SiteHeader.tsx
│  └─ SiteFooter.tsx
├─ components/          # shared UI components
│  └─ OnsetCurveView.tsx
├─ pages/              # Feature pages
│  ├─ FaqPage.tsx
│  ├─ HowItWorksPage.tsx
│  └─ StatusPage.tsx
├─ features/wizard/    # Multi-step interface
│  ├─ WizardLayout.tsx
│  ├─ components/      # AudioRecorder, VideoDropzone, MediaAnalysisPanel, ExportPanel
│  └─ steps/
├─ features/feedback/  # FeedbackDialog, TopicSelect
├─ shared/i18n/        # Internationalization
│  └─ locales/
└─ shared/ui/          # ErrorBoundary, LanguageSwitcher, index.css

labeler.html           # Annotation interface (special file)
```

### Especially Important
```
src/features/labeler/
├─ LabelerApp.tsx      # Main labeling app
├─ ShotTable.tsx       # Shot list
├─ ScoreBoard.tsx      # Statistics
└─ api.ts              # Server communication
```

### You DON'T Touch
- ❌ `src/domain/` — Detection Agent (algorithm logic)
- ❌ `eval/` — Tests Agent (measurement)
- ❌ Build config unless necessary

---

## Core Concepts

### Two Main UIs

**1. Main App (App.tsx)**
- Upload video
- Analyze & detect shots
- Edit, preview, export
- User workflow: see detected shots → edit → export

**2. Labeler (labeler.html)**
- Annotation tool for ground truth
- Mark shots for training/validation
- Tools: keyboard shortcuts, waveform, stats
- User workflow: load video → mark shots → save to labels/

### Keyboard Shortcuts (Labeler)
```
Space     Play/pause
A         Add shot at cursor (snaps to peak ±25ms)
E         Toggle: own → enemy → own
H         Mark as "hard" (noisy, buried)
X         Delete shot (or nearest if none selected)
J / K     Previous / next shot
← / →     Move ±20ms (Shift: ±500ms)
⌘S        Save
```

---

## Workflow

### Task: "Improve Labeler Usability"

1. **Identify Problem**
   - User feedback: "Shortcuts aren't obvious"
   - Or: "Navigation is slow"
   - Or: "Stats display confusing"

2. **Test Current State**
   ```bash
   pnpm dev
   # Open http://localhost:5173/labeler.html
   # Try it yourself: click around, use shortcuts
   ```

3. **Implement Improvement**
   - Edit component: `src/features/labeler/LabelerApp.tsx`
   - Or add help: show keyboard legend on load
   - Or improve UX: make shortcuts discoverable

4. **Test in Browser**
   ```bash
   pnpm dev
   # Hot reload: changes appear immediately
   # Try on different screen sizes (responsive)
   # Check performance: fast clicking shouldn't lag
   ```

5. **Commit with Rationale**
   ```bash
   git commit -m "ux: add keyboard shortcut legend to labeler

   - Shows common shortcuts (A, E, H, X) on first load
   - Help button toggles legend visibility
   - Improves discoverability for new users
   - No performance impact (CSS only)"
   ```

---

## Common Tasks

### "Labeling is tedious"

Ideas:
- Auto-advance to next unlabeled shot after marking
- Batch operations (mark multiple shots at once)
- Undo/redo for mistakes
- Faster navigation (hotkeys for jump to next FN)

**Test:**
```bash
pnpm dev
# Manually label 20 shots
# Time it: does it feel faster?
# Any UX friction remaining?
```

### "Export quality is bad"

Ideas:
- Show video preview before export
- Better progress indicator
- Quality settings (resolution, bitrate)
- Batch export multiple videos

**Test:**
```bash
pnpm dev
# Upload video, edit shots, export
# Check output quality (file size, dimensions)
# Is UI responsive during export?
```

### "Mobile doesn't work well"

Ideas:
- Responsive design (works on tablet)
- Touch-friendly buttons (larger hit areas)
- Mobile-optimized labeler
- Portrait/landscape support

**Test:**
```bash
pnpm dev
# Resize browser: F12 → toggle device toolbar
# Test on: iPhone (375px), iPad (768px), desktop (1280px)
# Does layout break? Are buttons clickable?
```

### "Language support"

Use `src/shared/i18n/`:
```typescript
// In component:
const { t } = useTranslation()
return <button>{t('common.ok')}</button>

// In locales/:
// en.json: { "common": { "ok": "OK" } }
// ru.json: { "common": { "ok": "ОК" } }
```

---

## Performance Monitoring

### "UI is slow"

Debug:
```bash
pnpm dev

# Browser DevTools: F12 → Performance tab
# Record: click button → see execution
# Look for: long tasks > 50ms (React, rendering)
# Check: does video preview stutter?
```

Common issues:
- Large video frames in DOM
- Re-rendering too often
- Blocking operations on main thread

### "Build is slow"

Check:
```bash
pnpm build
# How long does it take? (target: < 10s)

# If slow:
# - Check for large imports
# - Use React lazy() for heavy components
# - Measure bundle size: pnpm build --analyze (if available)
```

---

## Testing Checklist

Before committing any UI change:

- [ ] Visual: Does it look correct?
- [ ] Responsive: Works on mobile, tablet, desktop?
- [ ] Performance: No lag when interacting?
- [ ] Accessibility: Can keyboard navigate? (Tab, Enter)
- [ ] Functionality: Does intended feature work?
- [ ] Build: `pnpm build` completes without errors?
- [ ] No console errors: F12 → Console tab clean?

---

## Communication with Other Agents

### To Tests Agent
```
"I made UI changes to labeler.
Can you run pnpm build to check for any issues?"
```

**Tests response:**
```
"Build passes, no errors. UI changes are safe."
```

### From Detection Agent
```
"We have new detection results to display.
Can you add a stats panel showing F1/Precision/Recall?"
```

**Your response:**
```
"Done. Added StatsPanel component.
Shows metrics: F1 60%, Precision 90%, Recall 49%.
Updates when new eval results arrive."
```

---

## File Structure

### Key Components

| File | Purpose |
|------|---------|
| `app/App.tsx` | Main routing, pages |
| `features/wizard/WizardApp.tsx` | Multi-step editing workflow |
| `features/wizard/components/VideoDropzone.tsx` | Upload video |
| `features/wizard/components/MediaAnalysisPanel.tsx` | Show detection results |
| `features/wizard/components/ExportPanel.tsx` | Export video |
| `features/labeler/LabelerApp.tsx` | Annotation interface |
| `features/labeler/ShotTable.tsx` | List of shots |
| `shared/i18n/index.ts` | Language setup |

### CSS

- Global: `src/shared/ui/index.css`
- Per-component: next to the component (`src/features/*/components/*.css`)
- Layout: `src/features/wizard/WizardLayout.css`

---

## Accessibility (a11y)

**Basic checklist:**
- [ ] Images have alt text
- [ ] Buttons are keyboard accessible (Tab key)
- [ ] Color not only indicator (text + color)
- [ ] Labels associated with inputs
- [ ] Enough contrast (dark text on light bg)

**Test:**
```bash
# Keyboard-only: Tab through page, Enter to activate
# Screen reader: Try VoiceOver (Mac) or NVDA (Windows)
# Color blind: Chrome DevTools → Rendering → Emulate vision deficiency
```

---

## Styling

### Current Stack
- CSS modules or global CSS
- No CSS-in-JS (to keep it simple)
- Responsive: flexbox/grid + media queries

### Add a New Page

1. Create component: `src/pages/NewPage.tsx`
2. Create styles: `src/pages/NewPage.css`
3. Add to routing: `src/app/App.tsx`
   ```typescript
   import NewPage from './pages/NewPage'
   
   // In router:
   <Route path="/new" element={<NewPage />} />
   ```
4. Add link in navigation (if needed)

---

## Internationalization (i18n)

**Current support:** English, Russian

To add translation:
1. Edit `src/shared/i18n/locales/en.json`: add key-value
2. Edit `src/shared/i18n/locales/ru.json`: translate
3. Use in component:
   ```typescript
   const { t } = useTranslation()
   return <div>{t('myKey')}</div>
   ```

---

## Common Problems & Fixes

| Problem | Cause | Fix |
|---------|-------|-----|
| Hot reload not working | File not saved | Ctrl+S / ⌘S |
| Component not showing | Import missing | Check App.tsx routing |
| Styling looks weird | CSS conflict | Check browser DevTools (inspect element) |
| Build fails | Syntax error | Check console, `pnpm build` directly |
| Mobile broken | No mobile viewport meta | Check index.html `<meta name="viewport">` |

---

## Milestones (3 Months)

| Week | Focus | Labeler | Main App |
|------|-------|---------|----------|
| 2 | Foundation | Shortcuts work | Upload/preview works |
| 4 | UX | Keyboard legend | Edit interface intuitive |
| 6 | Polish | Faster navigation | Progress indicators |
| 8 | Localization | Russian UI | All pages translated |
| 10 | Mobile | Responsive | Touch-friendly |
| 12 | Production | Stable UX | No regressions |

---

## Success = ?

### Per Sprint (1-2 weeks)
- [ ] Identified one UX pain point
- [ ] Implemented fix (code + styling)
- [ ] Tested in browser (3 screen sizes)
- [ ] No console errors
- [ ] Committed with clear rationale
- [ ] Performance maintained

### By Week 12
- [ ] Labeler is intuitive (users find shortcuts in < 30s)
- [ ] Main app workflow is smooth (upload → edit → export works naturally)
- [ ] Responsive on mobile, tablet, desktop
- [ ] Fully localized (EN, RU)
- [ ] Accessible (keyboard navigation works)
- [ ] Fast (< 2s load time, no lag during interaction)

---

## Resources

- React docs: https://react.dev
- CSS tricks: https://css-tricks.com
- Accessibility: https://www.a11y-101.com
- i18next docs: https://www.i18next.com

---

## Questions?

Refer to:
- CLAUDE.md: Overall process
- AGENT_DETECTION.md: What Detection Agent needs
- AGENT_TESTS.md: What Tests Agent needs

When in doubt: ask Main (Claude) for clarification.
