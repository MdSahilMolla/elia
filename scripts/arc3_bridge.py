"""Official ARC toolkit transport. Never exposes environment source to the agent."""
import argparse
import importlib.metadata
import json
import logging
import sys
from pathlib import Path

PROTOCOL_OUT = sys.stdout
# Toolkit dependencies configure stdout loggers during import. Keep the JSON
# transport separate from all third-party output, including those loggers.
sys.stdout = sys.stderr

from arc_agi import Arcade, OperationMode
from arcengine import GameAction


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--games", default="")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    logger = logging.getLogger("arc3-benchmark")
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    logger.setLevel(logging.CRITICAL)
    arc = Arcade(
        operation_mode=OperationMode.NORMAL if args.prepare else OperationMode.OFFLINE,
        environments_dir=str(root / "environments"),
        recordings_dir=str(root / "recordings"),
        logger=logger,
    )
    if args.prepare:
        available = sorted(e.game_id for e in arc.get_environments())
        selected = args.games.split(",") if args.games else available
        downloaded = []
        for game in selected:
            env = arc.make(game)
            if env is None or env.observation_space is None:
                raise RuntimeError(f"Could not prepare {game}")
            downloaded.append(env.environment_info.game_id)
        arc.close_scorecard()
        print(json.dumps({"games": downloaded, "toolkit": importlib.metadata.version("arc-agi"), "engine": importlib.metadata.version("arcengine")}), file=PROTOCOL_OUT)
        return

    env = None
    def serialize_observation(observation):
        result = observation.model_dump(mode="json")
        # FrameDataRaw intentionally excludes its ndarray pixels from model_dump.
        result["frame"] = [layer.tolist() for layer in observation.frame]
        return result

    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if k not in ("api_key", "private_tags", "level_tags")}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value

    for line in sys.stdin:
        try:
            request = json.loads(line)
            operation = request["op"]
            if operation == "list":
                result = {"games": sorted(e.game_id for e in arc.get_environments()), "toolkit": importlib.metadata.version("arc-agi"), "engine": importlib.metadata.version("arcengine")}
            elif operation == "start":
                arc.close_scorecard()
                env = arc.make(request["game"], seed=0, save_recording=True)
                if env is None or env.observation_space is None:
                    raise ValueError("Environment unavailable")
                result = serialize_observation(env.observation_space)
            elif operation == "action":
                if env is None:
                    raise ValueError("No active environment")
                action = GameAction[request["action"]]
                if action != GameAction.RESET and action not in env.action_space:
                    raise ValueError("Action not available")
                if action == GameAction.ACTION6:
                    data = request.get("data", {})
                    if any(type(data.get(k)) is not int or not 0 <= data[k] <= 63 for k in ("x", "y")):
                        raise ValueError("ACTION6 requires integer x,y in [0,63]")
                observation = env.reset() if action == GameAction.RESET else env.step(action, data=request.get("data", {}))
                if observation is None:
                    raise RuntimeError("No observation returned")
                result = serialize_observation(observation)
            elif operation in ("score", "close"):
                card = arc.close_scorecard() if operation == "close" else arc.get_scorecard()
                if card is None:
                    raise RuntimeError("No scorecard")
                result = clean(card.model_dump(mode="json"))
            else:
                raise ValueError("Unknown operation")
            print(json.dumps({"ok": True, "result": result}), file=PROTOCOL_OUT, flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": type(error).__name__ + ": " + str(error)}), file=PROTOCOL_OUT, flush=True)


if __name__ == "__main__":
    main()
