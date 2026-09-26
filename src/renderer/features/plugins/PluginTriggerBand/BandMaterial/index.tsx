import { HERO_BAND } from '../../PluginsHero';

/**
 * Frozen liquid metal, right flank — the CSS-only sibling of the marketing
 * site's WebGL LiquidMetal hero (frink-marketing MetalBackdrop, "contour"
 * variant). Layer order matters: body, contours, crest, violet specular, then a
 * settle pass that pulls the left of the band back to near-black so the copy on
 * top stays readable rather than fighting the artwork.
 *
 * `tile-notch` repeats TileSurface's corner cut — these layers paint above the
 * primitive's clipped background, so without it the notch fills back in.
 *
 * impeccable-disable design-system-color -- steel steps, white feathers and the
 * one violet feather are the brand's established metal material; changing them
 * here would fork it away from the marketing site.
 */
export function BandMaterial() {
  return (
    <>
      <div
        className="tile-notch absolute inset-0 dark:hidden"
        style={{
          background: 'linear-gradient(115deg, hsl(var(--background)) 0%, hsl(var(--muted)) 100%)',
        }}
        aria-hidden
      />
      <div
        className="tile-notch absolute inset-0 hidden dark:block"
        style={{ background: HERO_BAND }}
        aria-hidden
      >
        {/* The frozen molten body — a conic sweep of steel greys reading as a thick
          ridge solidified mid-flow, masked to the right flank. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'conic-gradient(from 198deg at 88% 46%, #0f0f0f 0deg, #1f1f1f 40deg, #2d2d2d 84deg, #393939 124deg, #262626 162deg, #161616 206deg, #1d1d1d 268deg, #0f0f0f 318deg, #0f0f0f 360deg)',
            maskImage:
              'radial-gradient(96% 124% at 106% 48%, #000 0%, #000 28%, rgba(0,0,0,0.4) 58%, transparent 82%)',
            WebkitMaskImage:
              'radial-gradient(96% 124% at 106% 48%, #000 0%, #000 28%, rgba(0,0,0,0.4) 58%, transparent 82%)',
          }}
        />

        {/* Flow contours crossing the body at an angle, so the surface reads as
          layered rather than a single sweep. soft-light keeps them inside the metal. */}
        <div
          className="absolute inset-0 mix-blend-soft-light"
          style={{
            background:
              'conic-gradient(from 286deg at 82% 26%, transparent 0deg, rgba(45,45,45,0) 20deg, rgba(139,139,139,0.34) 48deg, rgba(35,35,35,0) 80deg, rgba(139,139,139,0.28) 116deg, rgba(20,20,20,0) 150deg, transparent 360deg)',
            maskImage: 'radial-gradient(82% 100% at 100% 40%, #000 0%, #000 32%, transparent 74%)',
            WebkitMaskImage:
              'radial-gradient(82% 100% at 100% 40%, #000 0%, #000 32%, transparent 74%)',
          }}
        />

        {/* The chrome crest: the highlight rolling over the frozen form. */}
        <div
          className="absolute inset-0 mix-blend-soft-light"
          style={{
            background:
              'conic-gradient(from 146deg at 99% 52%, transparent 0deg, rgba(139,139,139,0) 26deg, rgba(150,150,150,0.55) 58deg, rgba(226,226,230,0.36) 73deg, rgba(150,150,150,0.5) 90deg, rgba(45,45,45,0) 126deg, transparent 360deg)',
            maskImage: 'radial-gradient(66% 104% at 102% 52%, #000 0%, #000 34%, transparent 72%)',
            WebkitMaskImage:
              'radial-gradient(66% 104% at 102% 52%, #000 0%, #000 34%, transparent 72%)',
          }}
        />

        {/* One disciplined violet specular — the single electric signal, riding the
          crest and bleeding right only. */}
        <div
          className="absolute inset-0 mix-blend-screen"
          style={{
            background:
              'linear-gradient(116deg, transparent 0%, transparent 72%, rgba(255,255,255,0.09) 75.4%, rgba(255,255,255,0.3) 78.6%, rgba(214,202,255,0.3) 79.6%, rgba(167,139,250,0.2) 81.6%, rgba(167,139,250,0.07) 84.5%, transparent 87.5%, transparent 100%)',
            maskImage: 'radial-gradient(62% 94% at 100% 48%, #000 0%, #000 40%, transparent 78%)',
            WebkitMaskImage:
              'radial-gradient(62% 94% at 100% 48%, #000 0%, #000 40%, transparent 78%)',
          }}
        />

        {/* Broad machined crest: the wide silver bloom the band always had — the
          conic layers carve detail into it rather than replacing it. */}
        <div
          className="absolute inset-0 mix-blend-screen"
          style={{
            background:
              'radial-gradient(58% 150% at 96% 56%, rgba(184,184,188,0.3) 0%, rgba(120,120,124,0.16) 34%, rgba(40,40,42,0.05) 62%, transparent 82%)',
          }}
        />

        {/* Machined sheen: fine micro-banding over the flank so the chrome reads as
          brushed rather than painted. */}
        <div
          className="absolute inset-0 opacity-30 mix-blend-overlay"
          style={{
            background:
              'repeating-linear-gradient(92deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0) 1.5px, rgba(255,255,255,0) 3px, rgba(255,255,255,0) 4.5px)',
            maskImage: 'radial-gradient(58% 96% at 102% 48%, #000 0%, #000 30%, transparent 70%)',
            WebkitMaskImage:
              'radial-gradient(58% 96% at 102% 48%, #000 0%, #000 30%, transparent 70%)',
          }}
        />

        {/* Settle. Last layer, so it wins where the copy sits: darkens everything
          left of 80% and leaves the flank past 94% untouched. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(5,5,5,0.72) 0%, rgba(5,5,5,0.6) 55%, rgba(5,5,5,0.35) 78%, rgba(5,5,5,0) 92%)',
          }}
        />
      </div>
    </>
  );
}
