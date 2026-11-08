// First, so no schema is made with new Function, which the page's policy forbids.
import "@transit-agents/contracts/jitless";
import { render } from "preact";
import { App } from "./App.tsx";
import { finishSignIn } from "./session.ts";
import "./styles.css";

void finishSignIn().then(() => render(<App />, document.getElementById("app") as HTMLElement));
