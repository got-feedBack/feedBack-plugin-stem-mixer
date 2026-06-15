from fastapi import FastAPI


def setup(app: FastAPI, context: dict) -> None:
    @app.get("/api/plugins/stem_mixer/health")
    def stem_mixer_health():
        return {
            "ok": True,
            "plugin": "stem_mixer",
            "config_dir": str(context.get("config_dir", "")),
        }
