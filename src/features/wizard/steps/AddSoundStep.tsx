import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AudioSourcePicker } from '../components/AudioSourcePicker'
import { WizardLayout } from '../WizardLayout'
import './AddSoundStep.css'

interface AddSoundStepProps {
  onRecorded: (blob: Blob) => void
  onFileSelected: (file: File) => void
  onLibraryPick: (soundId: string, file: File) => void
  selectedLibraryId: string | null
  onBack: () => void
  decodeError: string | null
  /** Screen-level busy overlay (navigation), not quiet library decode. */
  busy: boolean
  isDecoding: boolean
  hasAudio: boolean
  onContinue: () => void
  /**
   * The meme currently in the clip.
   *
   * The step is no longer “pick a sound”: people arrive with a meme already in place,
   * and the first thing they need to know is which one. Hence the title says
   * “change”, not “pick”.
   */
  currentSoundName: string | null
}

export function AddSoundStep({
  onRecorded,
  onFileSelected,
  onLibraryPick,
  selectedLibraryId,
  onBack,
  decodeError,
  busy,
  isDecoding,
  hasAudio,
  onContinue,
  currentSoundName,
}: AddSoundStepProps) {
  const { t } = useTranslation()
  const [sourceError, setSourceError] = useState<string | null>(null)
  const error = decodeError ?? sourceError

  return (
    <WizardLayout
      step="add-sound"
      title={t('wizard.addSound.title')}
      /* Instead of the generic hint — what's in right now: people reach this step with a
         meme already inserted, and “grab a sound from the arsenal” tells the wrong story here.
         If the default meme failed to load, the old hint stays. */
      hint={
        currentSoundName ? (
          <span className="add-sound__swap">
            <i aria-hidden="true" />
            <span>
              <Trans
                i18nKey="wizard.addSound.swap"
                values={{ name: currentSoundName }}
                components={{ b: <b /> }}
              />
            </span>
          </span>
        ) : (
          t('wizard.addSound.hint')
        )
      }
      onBack={onBack}
      backLabel={t('wizard.addSound.back')}
      busy={busy}
      /*
       * THE BUTTON STAYS PUT WHILE A NEW SOUND IS DECODED — it neither vanishes nor dims.
       *
       * Picking a sound clears the decoded buffer immediately, BEFORE decoding starts, and
       * with `hasAudio` alone the button vanished for those milliseconds. The wizard footer
       * is sticky: the whole bar slid off the bottom of the screen with the button, and the
       * page jerked on every click in the arsenal — as if the whole screen had re-rendered.
       *
       * That a sound is picked is known from `currentSoundName`: it's set by the same action
       * that clears the buffer, so there's never a frame without the button. Disabling it
       * during decoding won't do either: picking from the arsenal takes a couple dozen
       * milliseconds, and instead of a jump we'd get a flicker. Arsenal decoding is QUIET by
       * design of this step; recording and own files take another path, where the screen is
       * honestly covered by an overlay (`busy`) and the button is disabled along with everything else.
       *
       * The button is absent only when there's truly nothing to proceed with: no sound picked
       * and nothing being decoded.
       */
      primaryAction={
        hasAudio || currentSoundName !== null
          ? {
              label: t('wizard.addSound.continue'),
              onClick: onContinue,
              disabled: (!hasAudio && !isDecoding) || busy || Boolean(decodeError),
            }
          : undefined
      }
    >
      {/* No `wizard__panel` wrapper: in the mockup the tabs and sound grid sit right on the
          page background, like the drop zone on the upload screen. */}
      <AudioSourcePicker
        onRecorded={onRecorded}
        onFileSelected={onFileSelected}
        onLibraryPick={(sound, file) => onLibraryPick(sound.id, file)}
        selectedLibraryId={selectedLibraryId}
        onError={setSourceError}
      />
      {error && <p className="card__error">{error}</p>}
    </WizardLayout>
  )
}
