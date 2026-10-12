"""Load $VDIRSYNCER_CONFIG with vdirsyncer's own parser and build every
storage, the way `vdirsyncer sync` would, minus the network.

That runs each password.fetch command, so it also proves vdirsyncer can get
the app-specific password through `abridge secret get`.
"""

import asyncio
import json
import os

import aiohttp
from vdirsyncer.cli.config import Config
from vdirsyncer.cli.utils import storage_class_from_config


async def main() -> None:
    config = Config.from_filename_or_environment()
    report = {"pairs": sorted(config.pairs), "storages": {}}
    async with aiohttp.TCPConnector() as connector:
        for name in config.storages:
            args = config.get_storage_args(name)
            cls, kwargs = storage_class_from_config(args)
            kwargs.pop("instance_name", None)
            if "url" in kwargs:
                kwargs["connector"] = connector
            cls(**kwargs)
            report["storages"][name] = {
                "type": args["type"],
                "password": args.get("password"),
                "item_types": args.get("item_types"),
            }
    with open(os.environ["VALIDATE_REPORT"], "w") as f:
        json.dump(report, f)


asyncio.run(main())
