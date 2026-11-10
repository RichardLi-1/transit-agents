# Fonts

The display is set in Google Sans, served from here, as the page loads nothing
from other sites.

- `GoogleSans-latin.woff2` and `GoogleSans-Italic-latin.woff2`: Google Sans,
  Copyright 2025 The Google Sans Project Authors
  ([github.com/googlefonts/googlesans](https://github.com/googlefonts/googlesans)),
  under the [SIL Open Font License 1.1](OFL.txt). From
  [google/fonts, ofl/googlesans](https://github.com/google/fonts/tree/main/ofl/googlesans),
  `GoogleSans[GRAD,opsz,wght].ttf` and its italic.

Each file keeps the Latin characters the display uses (Basic Latin, Latin-1,
general punctuation, arrows, the euro sign and the maths signs ≤ ≥ − ≈ ≠), keeps
the weight (400 to 700) and optical size (17 to 18) axes, and sets the grade
axis to 0. Subset and converted to WOFF2 with fontTools' `varLib.instancer` and
`pyftsubset`. "Google" and "Google Sans" are Google LLC's trademarks; the font is
named only to say which it is.
