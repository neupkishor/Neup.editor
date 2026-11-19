import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

/** Renders the starter title card in the Remotion Player and Studio. */
export const VideoComposition: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 18, 90, 120], [0, 1, 1, 0.9], {
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(frame, [0, 24], [24, 0], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 38%, #302147 0%, #17151f 42%, #0c0d12 100%)',
        color: '#fff',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', width: 500, height: 500, border: '1px solid #ffffff12', borderRadius: '50%' }} />
      <div style={{ position: 'absolute', width: 340, height: 340, border: '1px solid #ffffff14', borderRadius: '50%' }} />
      <div style={{ opacity, transform: `translateY(${rise}px)`, textAlign: 'center' }}>
        <div style={{ color: '#b794f6', fontSize: 20, letterSpacing: 8, textTransform: 'uppercase', marginBottom: 20 }}>
          A new story
        </div>
        <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -4 }}>Make it move.</div>
        <div style={{ color: '#aaa6b5', fontSize: 22, marginTop: 18 }}>Your first video starts here.</div>
      </div>
      <div style={{ position: 'absolute', bottom: 44, color: '#736d80', fontSize: 14, letterSpacing: 3 }}>NEUP CUT  ·  01</div>
    </AbsoluteFill>
  );
};
