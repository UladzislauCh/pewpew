import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

export interface TopicOption<T extends string> {
  value: T
  label: string
  description: string
}

interface TopicSelectProps<T extends string> {
  id: string
  labelId: string
  value: T
  options: readonly TopicOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  /** Tells the popup the list is open: Esc then closes the list, not the popup. */
  onOpenChange?: (open: boolean) => void
}

/**
 * Topic picker — a list with an explanation under each option.
 *
 * Not a `<select>`: the native list has no second line, and without it people guess
 * whether theirs is an “idea” or “not working”. In exchange, listbox roles and keyboard
 * handled by hand: arrows, Home/End, Enter and Space select, Esc closes, Tab moves on.
 */
export function TopicSelect<T extends string>({
  id,
  labelId,
  value,
  options,
  onChange,
  disabled = false,
  onOpenChange,
}: TopicSelectProps<T>) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value))
  const selected = options[selectedIndex]

  useEffect(() => {
    onOpenChange?.(open)
    if (open) listRef.current?.focus()
  }, [open, onOpenChange])

  const openList = () => {
    if (disabled) return
    setActive(selectedIndex)
    setOpen(true)
  }

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    close(true)
  }

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      openList()
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((i) => Math.min(last, i + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((i) => Math.max(0, i - 1))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(last)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        break
      case 'Escape':
        // Without this Esc would close the whole popup, while the person only meant the list.
        event.preventDefault()
        event.stopPropagation()
        close(true)
        break
      case 'Tab':
        close(false)
        break
    }
  }

  return (
    <div
      className="topic-select"
      ref={wrapRef}
      onBlur={(event) => {
        if (open && !wrapRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={open ? 'feedback__control topic-select__button topic-select__button--open' : 'feedback__control topic-select__button'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${labelId} ${id}`}
        disabled={disabled}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={onButtonKeyDown}
      >
        <span className="topic-select__value">{selected?.label}</span>
        <svg className="topic-select__chevron" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d={open ? 'M5 12l5-5 5 5' : 'M5 8l5 5 5-5'} />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          className="topic-select__list"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            const className = [
              'topic-select__option',
              index === active ? 'topic-select__option--active' : '',
              isSelected ? 'topic-select__option--selected' : '',
            ].filter(Boolean).join(' ')
            return (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                className={className}
                role="option"
                aria-selected={isSelected}
                onMouseMove={() => setActive(index)}
                // mousedown, not click: otherwise the list loses focus before the option is selected.
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(index)
                }}
              >
                <svg className="topic-select__tick" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                  {isSelected && <path d="M4 10.5l4 4 8-9" />}
                </svg>
                <span>
                  <span className="topic-select__label">{option.label}</span>
                  <span className="topic-select__description">{option.description}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
