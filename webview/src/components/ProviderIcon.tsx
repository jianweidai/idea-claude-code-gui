import { Claude, OpenAI, Gemini } from '@lobehub/icons';

interface ProviderIconProps {
  providerId: string;
  size?: number;
  colored?: boolean;
  className?: string;
}

function CursorIcon({
  size = 16,
  className,
  colored = false,
}: {
  size?: number;
  className?: string;
  colored?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      style={{ color: colored ? '#e0e0e0' : 'currentColor' }}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M22.106 5.68 12.5.135a.998.998 0 0 0-.998 0L1.893 5.68a.84.84 0 0 0-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 0 0 .998 0l9.608-5.547a.84.84 0 0 0 .42-.727V6.407a.84.84 0 0 0-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 0 0-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"
      />
    </svg>
  );
}

export function ProviderIcon({
  providerId,
  size = 16,
  colored = false,
  className,
}: ProviderIconProps) {
  switch (providerId) {
    case 'claude':
      return colored ? <Claude.Color size={size} className={className} /> : <Claude.Avatar size={size} className={className} />;
    case 'codex':
      return <OpenAI.Avatar size={size} className={className} />;
    case 'cursor':
      return <CursorIcon size={size} className={className} colored={colored} />;
    case 'gemini':
      return colored ? <Gemini.Color size={size} className={className} /> : <Gemini.Avatar size={size} className={className} />;
    default:
      return colored ? <Claude.Color size={size} className={className} /> : <Claude.Avatar size={size} className={className} />;
  }
}
