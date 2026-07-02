'use client';
import React, { useState, useEffect, useRef } from 'react';
import { AnimatedCrystalBall } from './AnimatedCrystalBall';

const FORTUNES = [
  'I see data in your future…',
  'The queries are strong with this one.',
  'A large dataset approaches.',
  'Your schema holds many secrets.',
  'I sense a missing JOIN…',
  'Terabytes of insight await.',
  'Ask, and the data shall reveal itself.',
  'A slow query lurks in the shadows.',
  'Your dashboards will thank you.',
  'SELECT * FROM your destiny.',
  'NULL values trouble the data spirits.',
  'I foresee a billion rows.',
  'The warehouse knows all.',
  'Cross-join with caution…',
  'Partitions hold the key.',
  'I sense deeply nested JSON…',
  'A great visualization draws near.',
  'Your pipeline will run true.',
  'Beware the Cartesian product.',
  'Insights beyond GROUP BY await…',
  'A foreign key mystery unfolds.',
  'A subquery within a subquery…',
  'The data lake whispers your name.',
  'Schema drift approaches from the east.',
  'Great insight is just one query away.',
  'I sense you need a window function.',
  'Many rows have yet to be queried.',
  'A partition key shall set you free.',
  'The stars align — and so do your tables.',
  'Your cluster hums with purpose.',
  'An index will bring clarity.',
  'Destiny favors those who cache their results.',
  'I see missing partitions… and regret.',
  'Even your cold storage has warmth.',
  'The data wants to be understood.',
  'A join key reveals the hidden truth.',
  'Bytes flow like cosmic rivers.',
];

const HOLD_MS   = 4000; // how long the text is fully visible
const FADE_MS   = 800;  // fade in / fade out duration
const CYCLE_MS  = HOLD_MS + FADE_MS * 2 + 600; // total time before next fortune

function pickFortune(exclude?: string): string {
  const pool = FORTUNES.filter(f => f !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function CrystalBallOracle({ ballSize = 88 }: { ballSize?: number }) {
  const [fortune, setFortune] = useState(() => FORTUNES[0]);
  const currentRef = useRef(fortune);

  useEffect(() => {
    const interval = setInterval(() => {
      const next = pickFortune(currentRef.current);
      currentRef.current = next;
      setFortune(next);
    }, CYCLE_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <style>{`
        @keyframes fortune-cycle {
          0%                                          { opacity: 0; }
          ${(FADE_MS / CYCLE_MS * 100).toFixed(1)}%  { opacity: 1; }
          ${((FADE_MS + HOLD_MS) / CYCLE_MS * 100).toFixed(1)}% { opacity: 1; }
          ${((FADE_MS * 2 + HOLD_MS) / CYCLE_MS * 100).toFixed(1)}% { opacity: 0; }
          100%                                        { opacity: 0; }
        }
      `}</style>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
        {/* Fortune text above the ball */}
        <p style={{
          height: 36,
          margin: '0 0 16px',
          fontSize: 13,
          fontStyle: 'italic',
          color: 'var(--text-muted, #6b7280)',
          fontFamily: "'Google Sans', sans-serif",
          letterSpacing: '0.015em',
          textAlign: 'center',
          maxWidth: 280,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: `fortune-cycle ${CYCLE_MS}ms ease-in-out infinite`,
        }}>
          {fortune}
        </p>

        {/* Crystal ball */}
        <AnimatedCrystalBall width={ballSize} height={ballSize} aria-hidden="true" />
      </div>
    </>
  );
}
