import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CURSOR_MODES, type CursorMode } from '../types';

interface CursorModeSelectProps {
  value: CursorMode;
  onChange: (mode: CursorMode) => void;
  disabled?: boolean;
}

/**
 * CursorModeSelect - Cursor 执行模式选择器
 * 支持 default / plan / ask
 */
export const CursorModeSelect = ({ value, onChange, disabled }: CursorModeSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentMode = CURSOR_MODES.find(m => m.id === value) || CURSOR_MODES[0];

  const getModeText = (modeId: CursorMode, field: 'label' | 'description') => {
    const key = `cursorModes.${modeId}.${field}`;
    const fallback = CURSOR_MODES.find(m => m.id === modeId)?.[field] || modeId;
    return t(key, { defaultValue: fallback });
  };

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    setIsOpen(!isOpen);
  }, [isOpen, disabled]);

  const handleSelect = useCallback((mode: CursorMode) => {
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        disabled={disabled}
        title={t('cursorModes.title', { defaultValue: '选择执行模式' })}
      >
        <span className="codicon codicon-run-all" />
        <span className="selector-button-text">{getModeText(currentMode.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={{ fontSize: '10px', marginLeft: '2px' }} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: '4px',
            zIndex: 10000,
          }}
        >
          {CURSOR_MODES.map((mode) => (
            <div
              key={mode.id}
              className={`selector-option ${mode.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(mode.id)}
              title={getModeText(mode.id, 'description')}
            >
              <span className="codicon codicon-rocket" />
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <span>{getModeText(mode.id, 'label')}</span>
                <span className="mode-description">{getModeText(mode.id, 'description')}</span>
              </div>
              {mode.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CursorModeSelect;
