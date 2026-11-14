// The landing page, at /landing. It loads nothing of the map or the main display.
import { render } from "preact";
import "./landing.css";

function Landing() {
  return (
    <main>
      <h1>Transit Agents</h1>
    </main>
  );
}

render(<Landing />, document.getElementById("app") as HTMLElement);
