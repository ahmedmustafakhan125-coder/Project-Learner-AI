/**
 * The brand mark.
 *
 * One component for every place the logo appears — nav, auth cards, footer — so
 * a future change to the artwork is one edit rather than six.
 *
 * The wordmark already reads "Project Learner AI", so it replaces the whole
 * previous lockup (spark badge plus text) rather than sitting beside it. The
 * alt text carries the name for anyone who cannot see the image.
 *
 * The source is a 2000px square on an opaque grey plate; `public/logo.png` is
 * that artwork with the plate made transparent, trimmed to the ink, and resized
 * to 3x the nav height so it stays crisp without shipping the original.
 */
export function BrandLogo({
  height = 34,
  className,
}: {
  height?: number;
  className?: string;
}) {
  // Intrinsic ratio of the trimmed artwork, so width never has to be guessed.
  const width = Math.round(height * (194 / 102));

  return (
    <img
      src="/logo.png"
      alt="Project Learner AI"
      width={width}
      height={height}
      className={className}
      style={{ height, width: 'auto', display: 'block' }}
    />
  );
}
