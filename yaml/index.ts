#!/usr/bin/env node

import { createExecuter } from "./yaml_executer.ts";


createExecuter().then(executer => executer.start());
