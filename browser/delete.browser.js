import { defineSuite } from "./matrix.js";

// Backspace, Delete, word delete, and files with CRLF line endings.
defineSuite("delete", ["BS.", "DL.", "WB.", "WD.", "CR."]);
