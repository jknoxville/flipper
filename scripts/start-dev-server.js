/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

const electronBinary = require('electron');
const codeFrame = require('babel-code-frame');
const socketIo = require('socket.io');
const express = require('express');
const detect = require('detect-port');
const child = require('child_process');
const Convert = require('ansi-to-html');
const chalk = require('chalk');
const http = require('http');
const path = require('path');
const Metro = require('../static/node_modules/metro');
const MetroResolver = require('../static/node_modules/metro-resolver');
const fs = require('fs');
const Watchman = require('../static/watchman');

const convertAnsi = new Convert();

const DEFAULT_PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, '..', 'static');

let shutdownElectron = undefined;

function launchElectron({devServerURL, bundleURL, electronURL}) {
  const args = [
    path.join(STATIC_DIR, 'index.js'),
    '--remote-debugging-port=9222',
    ...process.argv,
  ];

  const proc = child.spawn(electronBinary, args, {
    cwd: STATIC_DIR,
    env: {
      ...process.env,
      SONAR_ROOT: process.cwd(),
      BUNDLE_URL: bundleURL,
      ELECTRON_URL: electronURL,
      DEV_SERVER_URL: devServerURL,
    },
    stdio: 'inherit',
  });

  const electronCloseListener = () => {
    process.exit();
  };

  const processExitListener = () => {
    proc.kill();
  };

  proc.on('close', electronCloseListener);
  process.on('exit', processExitListener);

  return () => {
    proc.off('close', electronCloseListener);
    process.off('exit', processExitListener);
    proc.kill();
  };
}

function startMetroServer(app) {
  const projectRoot = path.join(__dirname, '..');
  return Metro.runMetro({
    projectRoot,
    watchFolders: [projectRoot],
    transformer: {
      babelTransformerPath: path.join(
        __dirname,
        '..',
        'static',
        'transforms',
        'index.js',
      ),
    },
    resolver: {
      blacklistRE: /(\/|\\)(sonar|flipper|flipper-public)(\/|\\)(dist|doctor)(\/|\\)|(\.native\.js$)/,
      resolveRequest: (context, moduleName, platform) => {
        if (moduleName.startsWith('./localhost:3000')) {
          moduleName = moduleName.replace('./localhost:3000', '.');
        }
        return MetroResolver.resolve(
          {...context, resolveRequest: null},
          moduleName,
          platform,
        );
      },
    },
    watch: true,
  }).then(metroBundlerServer => {
    app.use(metroBundlerServer.processRequest.bind(metroBundlerServer));
  });
}

function startAssetServer(port) {
  const app = express();

  app.use((req, res, next) => {
    if (knownErrors[req.url] != null) {
      delete knownErrors[req.url];
      outputScreen();
    }
    next();
  });

  app.use((req, res, next) => {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');
    next();
  });

  app.post('/_restartElectron', (req, res) => {
    if (shutdownElectron) {
      shutdownElectron();
    }
    shutdownElectron = launchElectron({
      devServerURL: `http://localhost:${port}`,
      bundleURL: `http://localhost:${port}/src/init.bundle`,
      electronURL: `http://localhost:${port}/index.dev.html`,
    });
    res.end();
  });

  app.get('/', (req, res) => {
    fs.readFile(path.join(STATIC_DIR, 'index.dev.html'), (err, content) => {
      res.end(content);
    });
  });

  app.use(express.static(STATIC_DIR));

  app.use(function(err, req, res, next) {
    knownErrors[req.url] = err;
    outputScreen();
    res.status(500).send('Something broke, check the console!');
  });

  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(port, 'localhost', () => resolve({app, server}));
  });
}

async function addWebsocket(server) {
  const io = socketIo(server);

  // notify connected clients that there's errors in the console
  io.on('connection', client => {
    if (hasErrors()) {
      client.emit('hasErrors', convertAnsi.toHtml(buildErrorScreen()));
    }
  });

  // refresh the app on changes to the src folder
  // this can be removed once metroServer notifies us about file changes
  try {
    const watchman = new Watchman(path.resolve(__dirname, '..', 'src'));
    await watchman.initialize();
    await watchman.startWatchFiles(
      '',
      () => {
        io.emit('refresh');
      },
      {
        excludes: [
          '**/__tests__/**/*',
          '**/node_modules/**/*',
          '**/.*',
          'plugins/**/*', // plugin changes are tracked separately, so exlcuding them here to avoid double reloading.
        ],
      },
    );
  } catch (err) {
    console.error(
      'Failed to start watching for changes using Watchman, continue without hot reloading',
      err,
    );
  }

  return io;
}

const knownErrors = {};

function hasErrors() {
  return Object.keys(knownErrors).length > 0;
}

function buildErrorScreen() {
  const lines = [
    chalk.red(`✖ Found ${Object.keys(knownErrors).length} errors`),
    '',
  ];

  for (const url in knownErrors) {
    const err = knownErrors[url];

    if (err.filename != null && err.lineNumber != null && err.column != null) {
      lines.push(chalk.inverse(err.filename));
      lines.push();
      lines.push(err.message);
      lines.push(
        codeFrame(
          fs.readFileSync(err.filename, 'utf8'),
          err.lineNumber,
          err.column,
        ),
      );
    } else {
      lines.push(err.stack);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function outputScreen(socket) {
  // output screen
  if (hasErrors()) {
    const errorScreen = buildErrorScreen();
    console.error(errorScreen);

    // notify live clients of errors
    socket.emit('hasErrors', convertAnsi.toHtml(errorScreen));
  } else {
    // eslint-disable-next-line no-console
    console.log(chalk.green('✔ No known errors'));
  }
}

(async () => {
  const port = await detect(DEFAULT_PORT);
  const {app, server} = await startAssetServer(port);
  const socket = await addWebsocket(server);
  await startMetroServer(app);
  outputScreen(socket);
  shutdownElectron = launchElectron({
    devServerURL: `http://localhost:${port}`,
    bundleURL: `http://localhost:${port}/src/init.bundle`,
    electronURL: `http://localhost:${port}/index.dev.html`,
  });
})();
