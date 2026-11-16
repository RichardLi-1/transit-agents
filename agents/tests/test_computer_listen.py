import unittest

import computer_listen as listen


def message(text: str, actor: str = "planner:demo", audience: str | None = None) -> dict:
    return {"seq": 5, "type": "activity", "actor": actor, "studyId": "ontario-line-don-mills", "audience": audience, "data": {"kind": "message", "text": text}}


class Trigger(unittest.TestCase):
    def test_a_planners_ask_for_the_simulator(self):
        self.assertEqual(listen.asked(message("Retime the Don Mills & Eglinton signal in the simulator")), "ontario-line-don-mills")

    def test_not_other_questions_visitors_or_agents(self):
        self.assertIsNone(listen.asked(message("What would it cost?")))
        self.assertIsNone(listen.asked(message("Retime the signal in the simulator", actor="guest:x", audience="guest-x")))
        self.assertIsNone(listen.asked(message("Opening the simulator", actor="agent:computer")))

    def test_summary_of_a_saved_run(self):
        lines = [
            "Gemini: Done.",
            "The app saved: SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s.",
            "Northbound left: 221.3 → 43.9 s/veh, LOS F → D. Intersection: 63.2 → 44.4 s/veh, LOS E → D (Run 1 → Run 2).",
            "7 model calls, 27,164 tokens in and 1,651 out, US$0.0203, reported to ontario-line-don-mills.",
        ]
        lines.insert(3, "A write authorised by the planner's decision at log 41.")
        text = listen.summary(lines, True)
        self.assertTrue(text.startswith("Done in the simulator, and saved: SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s."))
        self.assertIn("LOS F → D", text)
        self.assertIn("Saved as authorised by the planner's decision at log 41.", text)
        self.assertTrue(text.endswith("7 model calls."))

    def test_summary_of_a_failed_run(self):
        self.assertTrue(listen.summary(["The app saved: nothing."], False).startswith("The simulator run didn't finish"))

    def test_summary_of_a_run_stopped_for_a_planners_decision(self):
        why = "It would save the simulation model, a write to the simulation app, and no planner's decision in this study authorises it. A planner was asked (question computer-1a2b3c4d)."
        text = listen.summary(["The app saved: nothing.", f"Blocked: {why}"], True)
        self.assertTrue(text.startswith(f"The simulator run stopped before saving. {why}"))
        self.assertIn('authorizes {"app": "microsim", "action": "save"}', text)


    def test_summary_of_a_run_that_found_a_save_nobody_authorised(self):
        why = "The simulation app saved a change no planner's decision authorised: SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s. A planner was asked (question computer-1a2b3c4d)."
        lines = ["The app saved: SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s.", f"Unauthorised: {why}"]
        self.assertEqual(listen.summary(lines, True), f"The simulator run stopped. {why}")


class NoSelfConfirm(unittest.TestCase):
    def test_the_chats_run_says_yes_for_nobody(self):
        # Asking in the chat authorises nothing: only a planner's recorded decision does.
        run = listen.command("ontario-line-don-mills", "http://127.0.0.1:4100")
        self.assertNotIn("--confirm", run)
        self.assertEqual(run[run.index("--study") + 1], "ontario-line-don-mills")
        self.assertEqual(run[run.index("--app") + 1], "microsim")


if __name__ == "__main__":
    unittest.main()
