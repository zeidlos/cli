const clipboard = require('clipboardy');
const fs = require('fs');
const inquirer = require('inquirer');
const path = require('path');
const request = require('request-promise');
const validator = require('validator');
const yaml = require('js-yaml');

const passwordStorage = require('./password-storage')('circleci');

const circleConfig = {
  version: 2,
  jobs: {
    build: {
      docker: [
        {
          image: 'circleci/node:latest',
        },
      ],
      steps: [
        'checkout',
        {
          run: {
            name: 'install',
            command: 'npm install'
          }
        },
        {
          run: {
            name: 'release',
            command: 'npm run semantic-release || true',
          },
        },
      ],
    },
  },
};

async function getUserInput(info) {
  return await inquirer.prompt([
    {
      type: 'input',
      name: 'token',
      message: 'What is your CircleCI API token?',
      validate: input => input.length === 40 ? true : 'Invalid token length',
      default: async answers => {
        const clipboardValue = await clipboard.read();
        return clipboardValue.length === 40 ? clipboardValue : null
      },
      when: async answers => {
        try {
          const storedToken = await passwordStorage.get('token');
          return !info.options.keychain || info.options['ask-for-passwords'] || !storedToken;
        } catch (err) {
          info.log.error('Something went wrong with your stored api token. Delete them from your keychain and try again');
          process.exit(1)
        }
      }
    },
    {
      type: 'confirm',
      name: 'createConfigFile',
      message: 'Do you want a `config.yml` file with semantic-release setup?',
      default: true,
    },
    {
      // TODO: Add step to existing config.yml
      type: 'confirm',
      name: 'overwrite',
      default: false,
      message: 'Do you want to overwrite the existing `config.yml`?',
      when: answers => answers.createConfigFile && fs.existsSync('./.circleci/config.yml')
    },
  ]);
}

async function processToken(info)
{
  if (!info.circle.token) {
    info.circle.token = await passwordStorage.get('token')
  } else if (info.options.keychain) {
    passwordStorage.set('token', info.circle.token);
  }
}

async function setupCircleProject(info) {
  const defaultReq = request.defaults({ 
    headers: { 
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    qs: {
      'circle-token': info.circle.token
    },
    baseUrl: `https://circleci.com/api/v1.1/project/github/${info.ghrepo.slug[0]}/${info.ghrepo.slug[1]}/`,
    json: true, 
    simple: true 
  })
  
  await followProject(info, defaultReq);
  await addEnvironmentVariable(info, defaultReq, { name: 'GH_TOKEN', value: info.github.token });
  await addEnvironmentVariable(info, defaultReq, { name: 'NPM_TOKEN', value: info.npm.token });
}

async function followProject(info, defaultReq) {
  info.log.verbose(`Following repo ${info.ghrepo.slug[0]}/${info.ghrepo.slug[1]} on CircleCI...`)
  const uri = `/follow`;
  const success = await defaultReq.post(uri)
    .then(body => body.following)
    .catch(err => false)
  
  if (success) {
    info.log.info(`Succesfully followed repo ${info.ghrepo.slug[0]}/${info.ghrepo.slug[1]} on CircleCI.`)
  } else {
    info.log.error('Error following repo on CircleCI!');
    process.exit(1);
  }
  
}

async function addEnvironmentVariable(info, defaultReq, body) {
  info.log.verbose(`Adding environment variable ${body.name} to CircleCI project...`)
  const uri = `/envvar`;
  const success = await defaultReq.post(uri, { body } )
    .then(body => true)
    .catch(err => false)
  
  if (success) {
    info.log.info(`Successfully added environment variable ${body.name} to CircleCI project.`)
  } else {
    info.log.error('Error setting environment variables on CircleCI!');
    process.exit(1);
  }
}

function setupRequestLogging(info) {
  require('request-debug')(request, function(type, data, r) {
    switch (type) {
      case 'request':
        info.log.http('request', data.method, data.uri.replace(/(.*?=.{4}).*/g, '$1xxxx'))
        break;
      case 'response':
        info.log.http(data.statusCode, r.uri.href.replace(/(.*?=.{4}).*/g, '$1xxxx'))
        info.log.verbose('response', r.response.body)
      default:
        break;
    }
  })
}

async function createConfigFile(info) {
  if (!info.circle.createConfigFile 
    || (!info.circle.overwrite && fs.existsSync('./.circleci/config.yml'))) {
    info.log.verbose('Config file creation skipped.')
    return
  }

  if (!fs.existsSync('./.circleci/')) {
    info.log.verbose('Creating folder `./.circleci/`...');
    fs.mkdirSync('./.circleci')
  }
  const yml = yaml.safeDump(circleConfig);
  info.log.verbose('Writing `./.circleci/config.yml`...');
  fs.writeFileSync('./.circleci/config.yml', yml);
  info.log.info('Successfully written `./.circleci/config.yml`.');
}

function stopRequestLogging() {
  request.stopDebugging()
}

module.exports = async function(pkg, info) {
  info.circle = await getUserInput(info)
  setupRequestLogging(info)
  await processToken(info)
  await setupCircleProject(info)
  stopRequestLogging()
  await createConfigFile(info)
};
