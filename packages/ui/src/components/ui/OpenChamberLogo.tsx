import React, { useMemo } from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const themeContext = useOptionalThemeSystem();

  let isDark = true;
  if (themeContext) {
    isDark = themeContext.currentTheme.metadata.variant !== 'light';
  } else if (typeof window !== 'undefined') {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const strokeColor = useMemo(() => {
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-stroke').trim();
      if (fromVars) return fromVars;
    }
    return isDark ? 'white' : 'black';
  }, [isDark]);

  const fillColor = useMemo(() => {
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-face-fill').trim();
      if (fromVars) return fromVars;
    }
    return isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
  }, [isDark]);

  const logoFillColor = strokeColor;

  // Isometric cube geometry
  // edge=48, cos30=0.866, sin30=0.5, centerY=50
  const edge = 48;
  const cos30 = 0.866;
  const sin30 = 0.5;
  const centerY = 50;

  const top = { x: 50, y: centerY - edge };
  const left = { x: 50 - edge * cos30, y: centerY - edge * sin30 };
  const right = { x: 50 + edge * cos30, y: centerY - edge * sin30 };
  const center = { x: 50, y: centerY };
  const bottomLeft = { x: 50 - edge * cos30, y: centerY + edge * sin30 };
  const bottomRight = { x: 50 + edge * cos30, y: centerY + edge * sin30 };
  const bottom = { x: 50, y: centerY + edge };

  const topFaceCenterY = (top.y + left.y + center.y + right.y) / 4;
  const isoMatrix = `matrix(0.866, 0.5, -0.866, 0.5, 50, ${topFaceCenterY})`;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Neusis Code logo"
    >
      {/* Left face */}
      <path
        d={`M${center.x} ${center.y} L${left.x} ${left.y} L${bottomLeft.x} ${bottomLeft.y} L${bottom.x} ${bottom.y} Z`}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Right face */}
      <path
        d={`M${center.x} ${center.y} L${right.x} ${right.y} L${bottomRight.x} ${bottomRight.y} L${bottom.x} ${bottom.y} Z`}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Top face (no fill, stroke only) */}
      <path
        d={`M${top.x} ${top.y} L${left.x} ${left.y} L${center.x} ${center.y} L${right.x} ${right.y} Z`}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* N logo on top face */}
      <g opacity={isAnimated ? undefined : 1}>
        {isAnimated && (
          <animate
            attributeName="opacity"
            values="0.4;1;0.4"
            dur="3s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"
          />
        )}
        <g transform={`${isoMatrix} scale(0.75)`}>
          <path
            fillRule="evenodd"
            d="M-10,-14 L-4,-14 L4,14 L10,14 L10,-14 L4,-14 L-4,14 L-10,14 Z"
            fill={logoFillColor}
          />
        </g>
      </g>
    </svg>
  );
};
