import { Bricolage_Grotesque, Hanken_Grotesk } from "next/font/google";

/** Display face of the wall: headings and the big figures. */
export const wallDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-wall-display",
  display: "swap",
});

/** Body face of the wall: lists, notes, labels. */
export const wallBody = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-wall-body",
  display: "swap",
});
