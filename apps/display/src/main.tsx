import { render } from "preact";
import { App } from "./App.tsx";
import { finishSignIn } from "./session.ts";
import "./styles.css";

void finishSignIn().then(() => render(<App />, document.getElementById("app") as HTMLElement));
