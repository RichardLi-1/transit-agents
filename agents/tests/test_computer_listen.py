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
        text = listen.summary(lines, True)
        self.assertTrue(text.startswith("Done in the simulator, and saved: SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s."))
        self.assertIn("LOS F → D", text)
        self.assertIn("asked before saving", text)
        self.assertTrue(text.endswith("7 model calls."))

    def test_summary_of_a_failed_run(self):
        self.assertTrue(listen.summary(["The app saved: nothing."], False).startswith("The simulator run didn't finish"))


if __name__ == "__main__":
    unittest.main()
