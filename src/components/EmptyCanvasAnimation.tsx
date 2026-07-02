'use client';
import React, { useState, useEffect, useRef } from 'react';
import { AnimatedCrystalBall } from './AnimatedCrystalBall';

// Mystical rune characters that orbit around the ball
const RUNES = [
  '\u2727', // white four pointed star
  '\u2726', // black four pointed star
  '\u2736', // six pointed black star
  '\u2605', // black star
  '\u2b50', // star
  '\u2734', // eight pointed black star
  '\u2737', // eight pointed rectilinear black star
  '\u273A', // sixteen pointed asterisk
  '\u2742', // circled open centre eight pointed star
  '\u2749', // balloon-spoked asterisk
];

const ORACLE_MESSAGES = [
  'Awaiting your query...',
  'The crystal awaits...',
  'Ask, and the data shall answer.',
  'Visions will manifest here.',
  'The oracle is ready.',
];

const MSG_HOLD = 3500;
const MSG_FADE = 600;
const MSG_CYCLE = MSG_HOLD + MSG_FADE * 2 + 400;

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
}

function generateParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: 2 + Math.random() * 3,
    duration: 4 + Math.random() * 6,
    delay: Math.random() * 5,
    opacity: 0.15 + Math.random() * 0.35,
  }));
}

export function EmptyCanvasAnimation() {
  const [msgIndex, setMsgIndex] = useState(0);
  const [particles] = useState(() => generateParticles(18));
  const uid = React.useId().replace(/:/g, 'u');

  useEffect(() => {
    const interval = setInterval(() => {
      setMsgIndex(prev => (prev + 1) % ORACLE_MESSAGES.length);
    }, MSG_CYCLE);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <style>{`
        /* -- Floating particles -- */
        @keyframes ${uid}float {
          0%, 100% {
            transform: translateY(0) translateX(0) scale(1);
            opacity: var(--p-opacity);
          }
          25% {
            transform: translateY(-18px) translateX(8px) scale(1.2);
            opacity: calc(var(--p-opacity) * 1.4);
          }
          50% {
            transform: translateY(-30px) translateX(-5px) scale(0.8);
            opacity: calc(var(--p-opacity) * 0.5);
          }
          75% {
            transform: translateY(-12px) translateX(12px) scale(1.1);
            opacity: var(--p-opacity);
          }
        }

        /* -- Orbiting runes -- */
        @keyframes ${uid}orbit {
          from { transform: rotate(0deg) translateX(var(--orbit-r)) rotate(0deg); }
          to   { transform: rotate(360deg) translateX(var(--orbit-r)) rotate(-360deg); }
        }
        @keyframes ${uid}orbit-rev {
          from { transform: rotate(360deg) translateX(var(--orbit-r)) rotate(-360deg); }
          to   { transform: rotate(0deg) translateX(var(--orbit-r)) rotate(0deg); }
        }

        /* -- Glow ring pulse -- */
        @keyframes ${uid}glow-ring {
          0%, 100% {
            box-shadow:
              0 0 20px 2px rgba(100, 160, 255, 0.08),
              0 0 60px 8px rgba(100, 160, 255, 0.04);
            transform: scale(1);
          }
          50% {
            box-shadow:
              0 0 30px 6px rgba(100, 160, 255, 0.15),
              0 0 80px 16px rgba(100, 160, 255, 0.08);
            transform: scale(1.03);
          }
        }

        /* -- Text fade cycle -- */
        @keyframes ${uid}msg-cycle {
          0%   { opacity: 0; transform: translateY(4px); }
          ${(MSG_FADE / MSG_CYCLE * 100).toFixed(1)}% { opacity: 1; transform: translateY(0); }
          ${((MSG_FADE + MSG_HOLD) / MSG_CYCLE * 100).toFixed(1)}% { opacity: 1; transform: translateY(0); }
          ${((MSG_FADE * 2 + MSG_HOLD) / MSG_CYCLE * 100).toFixed(1)}% { opacity: 0; transform: translateY(-4px); }
          100% { opacity: 0; transform: translateY(-4px); }
        }

        /* -- Subtle breathing for the whole scene -- */
        @keyframes ${uid}breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.015); }
        }

        .${uid}root {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0;
          position: relative;
          animation: ${uid}breathe 6s ease-in-out infinite;
          user-select: none;
        }

        .${uid}scene {
          position: relative;
          width: 180px;
          height: 180px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .${uid}glow-ring {
          position: absolute;
          width: 110px;
          height: 110px;
          border-radius: 50%;
          animation: ${uid}glow-ring 3s ease-in-out infinite;
          pointer-events: none;
        }

        .${uid}orbit-track {
          position: absolute;
          width: 100%;
          height: 100%;
          top: 0;
          left: 0;
          pointer-events: none;
        }

        .${uid}rune {
          position: absolute;
          top: 50%;
          left: 50%;
          margin-top: -8px;
          margin-left: -8px;
          width: 16px;
          height: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          color: rgba(160, 200, 255, 0.5);
          text-shadow: 0 0 6px rgba(100, 160, 255, 0.4);
        }

        .${uid}particle {
          position: absolute;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(160, 200, 255, 0.8) 0%, transparent 70%);
          pointer-events: none;
        }

        .${uid}message {
          height: 24px;
          margin-top: 4px;
          font-size: 13px;
          font-style: italic;
          color: var(--text-muted, #6b7280);
          font-family: 'Google Sans', sans-serif;
          letter-spacing: 0.02em;
          text-align: center;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: ${uid}msg-cycle ${MSG_CYCLE}ms ease-in-out infinite;
        }
      `}</style>

      <div className={`${uid}root`}>
        <div className={`${uid}scene`}>
          {/* Glow ring behind the ball */}
          <div className={`${uid}glow-ring`} />

          {/* Floating particles */}
          {particles.map(p => (
            <div
              key={p.id}
              className={`${uid}particle`}
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.size,
                height: p.size,
                ['--p-opacity' as string]: p.opacity,
                animation: `${uid}float ${p.duration}s ease-in-out ${p.delay}s infinite`,
                opacity: p.opacity,
              }}
            />
          ))}

          {/* Orbiting runes -- two tracks, opposite directions */}
          <div className={`${uid}orbit-track`}>
            {RUNES.slice(0, 5).map((rune, i) => (
              <div
                key={`inner-${i}`}
                className={`${uid}rune`}
                style={{
                  ['--orbit-r' as string]: '62px',
                  animation: `${uid}orbit ${14 + i * 2}s linear ${i * -2.8}s infinite`,
                }}
              >
                {rune}
              </div>
            ))}
            {RUNES.slice(5).map((rune, i) => (
              <div
                key={`outer-${i}`}
                className={`${uid}rune`}
                style={{
                  ['--orbit-r' as string]: '82px',
                  fontSize: 8,
                  color: 'rgba(160, 200, 255, 0.3)',
                  animation: `${uid}orbit-rev ${18 + i * 3}s linear ${i * -3.6}s infinite`,
                }}
              >
                {rune}
              </div>
            ))}
          </div>

          {/* Crystal ball at center */}
          <AnimatedCrystalBall width={72} height={72} aria-hidden="true" />
        </div>

        {/* Cycling oracle message */}
        <p className={`${uid}message`} key={msgIndex}>
          {ORACLE_MESSAGES[msgIndex]}
        </p>
      </div>
    </>
  );
}
