// Zod builds faster parsers with new Function where a page allows it, and tests for
// that when each schema is made. The display's security policy forbids it, so the
// test shows as a security error in the browser's console on every load. A page
// imports this before anything else, so no schema is made with it.
import { z } from "zod";

z.config({ jitless: true });
