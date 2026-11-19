import { Composition, registerRoot } from 'remotion';
import { VideoComposition } from './VideoComposition';

/** Declares compositions available to Remotion Studio and the renderer. */
const RemotionRoot: React.FC = () => (
  <Composition
    id="StarterVideo"
    component={VideoComposition}
    durationInFrames={150}
    fps={30}
    width={1280}
    height={720}
  />
);

registerRoot(RemotionRoot);
