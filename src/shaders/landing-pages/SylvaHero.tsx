"use client";
// ARCWISE: entry point for <SylvaHero /> only. The code below is copied verbatim from the registered
// LandingPages.tsx (SHA-256 4d379461ad00…), lines for SYLVA_HERO_* and SylvaHero, restricted to the
// authored "living-green" variant, which loads the authored document by URL and needs no derived srcDoc.
// The full LandingPages.tsx is kept alongside for reference; it imports other ThreeUI pages this
// project does not ship, so it is excluded from the build.
import { splitTypographyProps, usePageTypography, type PageTypographyProps } from "./pageTypography";
import { LandingPageFrame, type LandingPageProps } from "./LandingPageFrame";
import { SYLVA_TYPOGRAPHY } from "./pageRecipes";

export const SYLVA_HERO_VARIANTS = ["living-green"] as const;
export type SylvaHeroVariant = (typeof SYLVA_HERO_VARIANTS)[number];

export type SylvaHeroProps = LandingPageProps & PageTypographyProps & { variant?: SylvaHeroVariant };

const SYLVA_HERO_BASE_URL = "/landing-pages/inner-green-3d.html";

const SYLVA_HERO_TITLES: Record<SylvaHeroVariant, string> = {
  "living-green": "Sylva — Into the living world",
};

export function SylvaHero({ variant = "living-green", ...props }: SylvaHeroProps) {
  const safeVariant = SYLVA_HERO_VARIANTS.includes(variant) ? variant : "living-green";
  const [type, frame] = splitTypographyProps(props);
  const customization = usePageTypography(SYLVA_TYPOGRAPHY, type);

  return (
    <LandingPageFrame
      {...frame}
      key={safeVariant}
      customization={customization}
      title={SYLVA_HERO_TITLES[safeVariant]}
      sourceUrl={SYLVA_HERO_BASE_URL}
    />
  );
}
