// @ts-check
/// <reference types="node" />
/// <reference types="mocha" />
/// <reference types="chai" />
/// <reference types="sinon" />
/// <reference types="supertest" />

'use strict';

const mochaList = require('mocha').reporters.Base.list;

/**
 * @param {Error} err
 * @param {string} title
 */
const mochaErrorLog = (err, title) => {
  // @ts-ignore
  mochaList([{
    err,
    fullTitle: () => title || 'Untitled'
  }]);
};

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const request = require('supertest');
const nock = require('nock');
const sinon = require('sinon');
const cloneDeep = require('lodash.clonedeep');
const urlModule = require('url');
const VError = require('verror');

const knex = require('../../lib/knex');
const dbUtils = require('../db-utils');

chai.use(chaiAsPromised);
const should = chai.should();

const isSinonStub = (value) => !!(value && value.restore && value.restore.sinon);

describe('WebMention API', function () {
  this.timeout(15000);

  let app;

  const Entry = require('../../lib/classes/entry');
  const WebMentionTemplates = require('webmention-testpinger').WebMentionTemplates;
  const microformatsVersion = require('@voxpelli/metadataparser-mf2').versions;
  const templateCollection = new WebMentionTemplates();

  /** @type {{limit: number, callback: () => void}[]} */
  let waitingForNotifications;

  /**
   * @param {number} [limit]
   * @returns {() => Promise<void>}
   */
  const waitForNotification = (limit) => {
    if (!isSinonStub(Entry.prototype._notify)) {
      let count = 0;

      sinon.stub(Entry.prototype, '_notify').callsFake(async () => {
        count += 1;
        waitingForNotifications.reduce((position, options) => {
          const limit = position + options.limit;
          if (count === limit) {
            options.callback();
          }
          return limit;
        }, 0);
      });
    }

    /** @type {Promise<void>} */
    const notificationPromise = new Promise(resolve => {
      waitingForNotifications.push({
        limit: limit === undefined ? 1 : limit,
        callback: resolve
      });
    });

    return () => notificationPromise;
  };

  before(() => {
    return dbUtils.clearDb()
      .then(dbUtils.setupSchema)
      .then(() => {
        const main = require('../../lib/main');

        app = main.app;

        return new Promise(resolve => setTimeout(resolve, 1000));
      });
  });

  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');

    waitingForNotifications = [];

    return dbUtils.clearDb()
      .then(dbUtils.setupSchema)
      .then(dbUtils.setupSampleData);
  });

  afterEach(() => {
    sinon.verifyAndRestore();

    if (!nock.isDone()) {
      throw new Error('pending mocks: ' + nock.pendingMocks());
    }
  });

  describe('parseSourcePage', () => {
    it('should handle the templates alright', () => {
      const mentionTargets = require('../template-mentions.json');
      const templateMocks = [];
      let templateCount;

      return templateCollection.getTemplateNames()
        .then(templateNames => {
          const templates = [];

          templateCount = templateNames.length;

          templateNames.forEach(name => {
            const resolveTemplate = templateCollection.getTemplate(name, 'http://example.org/foo').then(template => {
              templateMocks.push(
                nock('http://' + name + '.example.com')
                  .get('/')
                  .reply(200, () => template)
              );
            }).then(() => name);
            templates.push(resolveTemplate);
          });

          return Promise.all(templates);
        })
        .then(templateNames => {
          const requests = [];

          templateNames.forEach(name => {
            requests.push(new Promise((resolve, reject) => {
              request(app)
                .post('/api/webmention')
                .send({
                  source: 'http://' + name + '.example.com/',
                  target: 'http://example.org/foo'
                })
                .expect(202)
                .end(err => {
                  if (err) {
                    return reject(err);
                  }
                  resolve();
                });
            }));
          });

          return Promise.all(requests).then(waitForNotification(templateNames.length));
        })
        .then(() => knex('entries').select('url', 'type', 'data', 'raw', 'mfversion'))
        .then(result => {
          templateMocks.forEach(templateMock => {
            templateMock.done();
          });

          result.should.be.an('array').be.of.length(templateCount);

          return Promise.all(result.map(templateMention => Promise.resolve().then(() => {
            const name = urlModule.parse(templateMention.url).hostname.replace('.example.com', '');

            if (name && mentionTargets[name]) {
              const target = cloneDeep(mentionTargets[name]);

              // Some templates don't have a published date, falling back to
              // Date.now() which messes up the deepEqual(). Working around it.
              if (target.published === undefined) {
                target.published = templateMention.data.published;
              }

              templateMention.data.should.deep.equal(target);

              if (target.interactionType) {
                should.equal(templateMention.type, target.interactionType);
              } else {
                should.not.exist(templateMention.type);
              }

              templateMention.mfversion.should.equal('mf2::' + microformatsVersion.version + '::' + microformatsVersion.microformatsVersion);
            } else {
              // Uncomment to inspect new templates to easily add them to ../template-mentions.json
              // console.log(JSON.stringify(templateMention.data));
              // console.log(JSON.stringify(templateMention.raw));
            }
          }).catch(err => {
            mochaErrorLog(err, 'Template error');
            throw err;
          })));
        });
    });

    it('should handle pings asynchronously', () => {
      let templateMock;

      return templateCollection.getTemplateNames()
        .then(templateNames => templateNames[0])
        .then(templateName => templateCollection.getTemplate(templateName, 'http://example.org/foo'))
        .then(template => nock('http://example.com/')
          .get('/')
          .reply(200, () => template)
        )
        .then(mock => {
          templateMock = mock;

          return new Promise((resolve, reject) => {
            request(app)
              .post('/api/webmention')
              .send({
                source: 'http://example.com/',
                target: 'http://example.org/foo'
              })
              .expect(202)
              .end(err => {
                if (err) {
                  return reject(err);
                }
                resolve();
              });
          });
        })
        .then(waitForNotification())
        .then(() => Promise.all([
          knex('entries').count('id').first(),
          knex('mentions').count('eid').first()
        ]))
        .then(result => {
          templateMock.done();
          result.should.deep.equal([
            { count: '1' },
            { count: '1' }
          ]);
        });
    });

    it('should send a live update', done => {
      let templateMock;

      let updates = '';

      request(app)
        .get('/api/mentions/live?site=example.org')
        .query({ site: 'example.org' })
        .buffer(false)
        .end().on('response', res => {
          const listener = (data) => {
            updates += data;
            if (data.indexOf('data:') === 0) {
              updates.should.contain('event: mention\ndata: {"url":"');
              res.removeListener('data', listener);
              result
                .then(() => knex('entries').count('id').first())
                .then(result => {
                  templateMock.done();
                  result.count.should.be.a('string').and.equal('1');
                })
                .then(() => { done(); })
                .catch(err => { done(new VError(err, 'DB call failed')); });
            }
          };
          res.on('data', listener);
        });

      const result = templateCollection.getTemplateNames()
        .then(templateNames => templateNames[0])
        .then(templateName => templateCollection.getTemplate(templateName, 'http://example.org/foo'))
        .then(template => nock('http://example.com/')
          .get('/')
          .reply(200, () => template)
        )
        .then(mock => {
          templateMock = mock;

          return new Promise((resolve, reject) => {
            request(app)
              .post('/api/webmention')
              .send({
                source: 'http://example.com/',
                target: 'http://example.org/foo'
              })
              .expect(202)
              .end(err => {
                if (err) {
                  return reject(err);
                }
                resolve();
              });
          });
        });
    });

    it('should handle multiple mentions', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .times(2)
        .reply(200, () =>
          '<div class="h-entry">' +
            '<a href="http://example.org/foo">First</a>' +
            '<a href="http://example.org/bar">second</a>' +
          '</div>'
        );

      return Promise.all(
        [
          'http://example.org/foo',
          'http://example.org/bar'
        ].map(target =>
          new Promise((resolve, reject) => {
            request(app)
              .post('/api/webmention')
              .send({
                source: 'http://example.com/',
                target
              })
              .expect(202)
              .end(err => {
                if (err) {
                  return reject(err);
                }
                resolve();
              });
          })
            .then(waitForNotification())
        )
      )
        .then(() => knex('mentions').count('url').first())
        .then((result) => {
          templateMock.done();
          result.count.should.be.a('string').and.equal('2');
        });
    });

    it('should update all existing source mentions on valid ping', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.org/foo">First</a>' +
            '<a href="http://example.org/bar">second</a>' +
          '</div>'
        )
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a class="u-like-of" href="http://example.org/foo">First</a>' +
            '<a href="http://example.org/bar">second</a>' +
          '</div>'
        );

      return [
        'http://example.org/foo',
        'http://example.org/bar'
      ].reduce(
        (promiseChain, target) => promiseChain.then(() =>
          new Promise((resolve, reject) => {
            request(app)
              .post('/api/webmention')
              .send({
                source: 'http://example.com/',
                target
              })
              .expect(202)
              .end(err => {
                if (err) { return reject(err); }
                resolve();
              });
          })
        ).then(waitForNotification()),
        Promise.resolve()
      )
        .then(() => { templateMock.done(); })
        .then(() => knex('mentions').select().orderBy('url', 'desc'))
        .then(result => {
          result.should.be.an('array').with.a.lengthOf(2);

          result.should.have.nested.property('[0].url', 'http://example.org/foo');
          result.should.have.nested.property('[0].interaction', true);
          result.should.not.have.nested.property('[0].updated', null);
          result.should.have.nested.property('[0].removed', false);

          result.should.have.nested.property('[1].url', 'http://example.org/bar');
          result.should.have.nested.property('[1].interaction', false);
          result.should.have.nested.property('[1].updated', null);
          result.should.have.nested.property('[1].removed', false);
        })
        .then(() => knex('entries').select())
        .then(result => {
          result.should.be.an('array').with.a.lengthOf(1);

          result.should.have.nested.property('[0].url', 'http://example.com/');
          result.should.have.nested.property('[0].published').that.is.a('date');
          result.should.have.nested.property('[0].updated').that.is.a('date').that.not.equals(result[0].published);
          result.should.have.nested.property('[0].type', 'like');
          result.should.have.nested.property('[0].data.interactionType', 'like');
          result.should.have.nested.property('[0].data.interactions').that.deep.equals(['http://example.org/foo']);
        });
    });

    it('should update on repeated ping', () => {
      const templateMock1 = nock('http://example.com')
        .get('/')
        .times(1)
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.org/foo">First</a>' +
          '</div>'
        );

      const templateMock2 = nock('http://example.com')
        .get('/')
        .times(1)
        .reply(200, () => '<div class="h-entry">' +
            '<a class="u-like-of" href="http://example.org/foo">First</a>' +
          '</div>'
        );

      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.com/',
            target: 'http://example.org/foo'
          })
          .expect(202)
          .end(err => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
      })
        .then(waitForNotification())
        .then(() => {
          templateMock1.done();
          return knex('entries').select();
        })
        .then(result => {
          result.should.be.an('array').with.a.lengthOf(1);
          result.should.have.nested.property('[0].published').that.is.a('date');
          result.should.have.nested.property('[0].updated').that.is.a('date');
          result.should.have.nested.property('[0].type', null);
          result.should.not.have.nested.property('[0].data.interactionType');
          result.should.not.have.nested.property('[0].data.interactions');

          result[0].published.valueOf()
            .should.equal(result[0].updated.valueOf());
        })
        .then(() =>
          new Promise((resolve, reject) => {
            request(app)
              .post('/api/webmention')
              .send({
                source: 'http://example.com/',
                target: 'http://example.org/foo'
              })
              .expect(202)
              .end(err => {
                if (err) {
                  return reject(err);
                }
                resolve();
              });
          })
        )
        .then(waitForNotification())
        .then(() => {
          templateMock2.done();
          return knex('entries').select();
        })
        .then(result => {
          result.should.be.an('array').with.a.lengthOf(1);
          result.should.have.nested.property('[0].published').that.is.a('date');
          result.should.have.nested.property('[0].updated').that.is.a('date').that.not.equals(result[0].published);
          result.should.have.nested.property('[0].type', 'like');
          result.should.have.nested.property('[0].data.interactionType', 'like');
          result.should.have.nested.property('[0].data.interactions').that.deep.equals(['http://example.org/foo']);
        });
    });

    it('should update remove all outdated source mentions on valid ping', () => {
      const templateMock1 = nock('http://example.com')
        .get('/')
        .times(1)
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.org/foo">First</a>' +
          '</div>'
        );

      const templateMock2 = nock('http://example.com')
        .get('/')
        .times(1)
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.org/bar">second</a>' +
          '</div>'
        );

      return [
        'http://example.org/foo',
        'http://example.org/bar'
      ].reduce(
        (promiseChain, target) => promiseChain.then(() =>
          new Promise((resolve, reject) => {
            request(app)
              .post('/api/webmention')
              .send({
                source: 'http://example.com/',
                target
              })
              .expect(202)
              .end(err => {
                if (err) { return reject(err); }
                resolve();
              });
          })
        ).then(waitForNotification()),
        Promise.resolve()
      )
        .then(() => knex('mentions').select().orderBy('url', 'desc'))
        .then(result => {
          templateMock1.done();
          templateMock2.done();

          result.should.be.an('array').with.a.lengthOf(2);

          result.should.have.nested.property('[0].url', 'http://example.org/foo');
          result.should.have.nested.property('[0].interaction', false);
          result.should.not.have.nested.property('[0].updated', null);
          result.should.have.nested.property('[0].removed', true);

          result.should.have.nested.property('[1].url', 'http://example.org/bar');
          result.should.have.nested.property('[1].interaction', false);
          result.should.have.nested.property('[1].updated', null);
          result.should.have.nested.property('[1].removed', false);
        });
    });

    it('should properly handle pings of site that returns 404:s');

    it('should fetch comments found on mentions', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.org/foo">First</a>' +
            '<a class="u-comment" href="http://example.com/foo">First</a>' +
          '</div>'
        )
        .get('/foo')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.com/">First</a>' +
          '</div>'
        );

      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.com/',
            target: 'http://example.org/foo'
          })
          .expect(202)
          .end(err => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
      })
        .then(waitForNotification(2))
        .then(() =>
          Promise.all([
            knex('entries').count('id').first(),
            knex('mentions').count('eid').first()
          ])
        )
        .then(result => {
          templateMock.done();
          result.should.deep.equal([
            { count: '2' },
            { count: '2' }
          ]);
        });
    });

    it('should fetch responses-links found on mentions', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.org/foo">First</a>' +
            '<a class="u-responses" href="http://example.com/bar">First</a>' +
          '</div>'
        )
        .get('/bar')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a class="u-url" href="http://example.com/foo">First</a>' +
          '</div>'
        )
        .get('/foo')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.com/">First</a>' +
          '</div>'
        );

      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.com/',
            target: 'http://example.org/foo'
          })
          .expect(202)
          .end(err => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
      })
        .then(waitForNotification(2))
        .then(() =>
          Promise.all([
            knex('entries').count('id').first(),
            knex('mentions').count('eid').first()
          ])
        )
        .then(result => {
          templateMock.done();
          result.should.deep.equal([
            { count: '2' },
            { count: '2' }
          ]);
        });
    });

    it('should fetch and ping upstream salmention targets of mention', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.net/foo">First</a>' +
          '</div>'
        );

      const targetMock = nock('http://example.net')
        .get('/foo')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a class="u-in-reply-to" href="http://example.net/bar">First</a>' +
          '</div>'
        )
        .get('/bar')
        .once()
        .reply(200, () => '<html><head>' +
            '<link rel="webmention" href="http://webmention.example.com/ping" />' +
          '</head><body>' +
              '<div class="h-entry">a simple linkless entry</div>' +
          '</html>'
        );

      const pingMock = nock('http://webmention.example.com')
        .post('/ping', {
          source: 'http://example.net/foo',
          target: 'http://example.net/bar'
        })
        .once()
        .reply(202);

      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.com/',
            target: 'http://example.net/foo'
          })
          .expect(202)
          .end(err => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
      })
        .then(waitForNotification(3))
        // TODO: Improve – relyng on timers in tests are pretty fragile
        .then(() =>
          new Promise(resolve => {
            setTimeout(resolve, 300);
          })
        )
        .then(() =>
          Promise.all([
            knex('entries').count('id').first(),
            knex('mentions').count('eid').first()
          ])
        )
        .then(result => {
          templateMock.done();
          targetMock.done();
          pingMock.done();
          result.should.deep.equal([
            { count: '3' },
            { count: '1' }
          ]);
        });
    });

    it('should fetch and ping upstream salmention targets on downstream mention', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.net/foo">First</a>' +
            '<a class="u-comment" href="http://example.com/foo">First</a>' +
          '</div>'
        )
        .get('/foo')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.com/">First</a>' +
          '</div>'
        );

      const targetMock = nock('http://example.net')
        .get('/foo')
        .twice() // TODO: Should be .once() really
        .reply(200, () => '<div class="h-entry">' +
            '<a class="u-in-reply-to" href="http://example.net/bar">First</a>' +
          '</div>'
        )
        .get('/bar')
        .twice() // TODO: Should be .once() really
        .reply(200, () => '<html><head>' +
            '<link rel="webmention" href="http://webmention.example.com/ping" />' +
          '</head><body>' +
              '<div class="h-entry">a simple linkless entry</div>' +
          '</html>'
        );

      const pingMock = nock('http://webmention.example.com')
        .post('/ping', {
          source: 'http://example.net/foo',
          target: 'http://example.net/bar'
        })
        .twice() // TODO: Should be .once() really
        .reply(202);

      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.com/',
            target: 'http://example.net/foo'
          })
          .expect(202)
          .end(err => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
      })
        .then(waitForNotification(4))
        // TODO: Improve – relyng on timers in tests are pretty fragile
        .then(() =>
          new Promise(resolve => {
            setTimeout(resolve, 300);
          })
        )
        .then(() =>
          Promise.all([
            knex('entries').count('id').first(),
            knex('mentions').count('eid').first()
          ])
        )
        .then(result => {
          templateMock.done();
          targetMock.done();
          pingMock.done();
          result.should.deep.equal([
            { count: '4' },
            { count: '2' }
          ]);
        });
    });

    it('should fetch and ping upstream salmention person tags', () => {
      const templateMock = nock('http://example.com')
        .get('/')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.net/foo">First</a>' +
          '</div>'
        );

      const targetMock = nock('http://example.net')
        .get('/foo')
        .once()
        .reply(200, () => '<div class="h-entry">' +
            '<a href="http://example.net/bar" class="u-category h-card">Bob Smith</a>' +
          '</div>'
        )
        .get('/bar')
        .once()
        .reply(200, () => '<html><head>' +
            '<link rel="webmention" href="http://webmention.example.com/ping" />' +
          '</head><body>' +
              '<div class="h-entry">a simple linkless entry</div>' +
          '</html>'
        );

      const pingMock = nock('http://webmention.example.com')
        .post('/ping', {
          source: 'http://example.net/foo',
          target: 'http://example.net/bar'
        })
        .once()
        .reply(202);

      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.com/',
            target: 'http://example.net/foo'
          })
          .expect(202)
          .end(err => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
      })
        .then(waitForNotification(3))
        // TODO: Improve – relyng on timers in tests are pretty fragile
        .then(() =>
          new Promise(resolve => {
            setTimeout(resolve, 300);
          })
        )
        .then(() =>
          Promise.all([
            knex('entries').count('id').first(),
            knex('mentions').count('eid').first()
          ])
        )
        .then(result => {
          templateMock.done();
          targetMock.done();
          pingMock.done();
          result.should.deep.equal([
            { count: '3' },
            { count: '1' }
          ]);
        });
    });

    it('should reject malformed source URL:s', () => {
      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'invalid',
            target: 'http://example.org/foo'
          })
          .expect(400)
          .end(err => err ? reject(err) : resolve());
      });
    });

    it('should reject malformed target URL:s', () => {
      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.org/foo',
            target: 'invalid'
          })
          .expect(400)
          .end(err => err ? reject(err) : resolve());
      });
    });

    it('should reject when source and target URL:s are equal', () => {
      return new Promise((resolve, reject) => {
        request(app)
          .post('/api/webmention')
          .send({
            source: 'http://example.org/foo',
            target: 'http://example.org/foo'
          })
          .expect(400)
          .end(err => err ? reject(err) : resolve());
      });
    });

    it('should reject when normalized source and target URL:s are equal', () => {
      return Promise.all([
        new Promise((resolve, reject) => {
          request(app)
            .post('/api/webmention')
            .send({
              source: 'https://example.org/foo',
              target: 'http://example.org/foo'
            })
            .expect(400)
            .end(err => err ? reject(err) : resolve());
        }),
        new Promise((resolve, reject) => {
          request(app)
            .post('/api/webmention')
            .send({
              source: 'https://www.example.org/foo',
              target: 'http://example.org/foo/#foobar'
            })
            .expect(400)
            .end(err => err ? reject(err) : resolve());
        })
      ]);
    });
  });

  describe('fetch mentions', () => {
    beforeEach(() => dbUtils.setupSampleMentions());

    const matchMentions = (done, count, err, res) => {
      if (err) {
        return done(err);
      }

      res.body.should.be.an('array').of.length(count);

      res.body.should.have.nested.property('[0].name', null);
      res.body.should.have.nested.property('[0].url').that.match(/^https?:\/\/[^/]+\//);
      res.body.should.have.nested.property('[0].author.name').that.is.a('string');

      res.body.should.have.nested.property('[0].author.photo')
        .that.is.a('string')
        .that.match(/^https?:\/\/[^/]+\//);

      res.body.should.have.nested.property('[0].author.url')
        .that.is.a('string')
        .that.match(/^https?:\/\/[^/]+\//);

      res.body.should.have.nested.property('[0].published')
        .that.is.a('number')
        .that.is.closeTo(Date.now(), 31 * 24 * 60 * 60 * 1000);

      res.body.should.have.nested.property('[0].targets')
        .that.is.an('array')
        .of.length.above(0);

      res.body.should.have.nested.property('[0].type')
        .that.is.a('string')
        .that.match(/^(like|repost|reply|mention)$/);

      res.body.should.have.nested.property('[0].interactions')
        .that.is.an('array');

      done();
    };

    it('should return all matching mentions in an expected format', (done) => {
      request(app)
        .get('/api/mentions')
        .query({ url: 'http://example.org/foo' })
        .expect(200)
        .end((err, res) => matchMentions(done, 4, err, res));
    });

    it('should return example mentions in an expected format', (done) => {
      request(app)
        .get('/api/mentions')
        .query({ example: 1 })
        .expect(200)
        .end((err, res) => matchMentions(done, 14, err, res));
    });

    // Test the resolveDerivedData() method and use
    it.skip('should derive interaction target status correctly');

    it('should allow matching based on hostname', (done) => {
      request(app)
        .get('/api/mentions')
        .query({ site: 'example.org' })
        .expect(200)
        .end((err, res) => {
          if (err) {
            return done(err);
          }

          res.body.should.be.an('array').of.length(10);
          res.body.should.have.nested.property('[0].author.name');

          done();
        });
    });

    it('should ignore www. in hostname', (done) => {
      request(app)
        .get('/api/mentions')
        .query({ site: 'www.example.org' })
        .expect(200)
        .end((err, res) => {
          if (err) {
            return done(err);
          }

          res.body.should.be.an('array').of.length(10);
          res.body.should.have.nested.property('[0].author.name');

          done();
        });
    });

    it('should allow matching based on path', () => {
      return [
        () => new Promise((resolve, reject) => {
          request(app)
            .get('/api/mentions')
            .query({ path: 'http://example.org/path' })
            .expect(200)
            .end((err, res) => {
              if (err) {
                return reject(err);
              }

              res.body.should.be.an('array').of.length(9);
              res.body.should.have.nested.property('[0].author.name');

              resolve();
            });
        }),
        () => new Promise((resolve, reject) => {
          request(app)
            .get('/api/mentions')
            .query({ path: 'http://example.org/foo' })
            .expect(200)
            .end((err, res) => {
              if (err) {
                return reject(err);
              }

              res.body.should.be.an('array').of.length(4);
              res.body.should.have.nested.property('[0].author.name');

              resolve();
            });
        }),
        () => new Promise((resolve, reject) => {
          // Test that the escaping works
          request(app)
            .get('/api/mentions')
            .query({ path: ['http://example.org/%h', 'http://example.org/p_th'] })
            .expect(200)
            .end((err, res) => {
              if (err) {
                return reject(err);
              }

              res.body.should.be.an('array').of.length(0);

              resolve();
            });
        })
      ].reduce((result, next) => result.then(next), Promise.resolve());
    });

    it('should ignore handle multiple matches', (done) => {
      request(app)
        .get('/api/mentions')
        .query({
          url: [
            'http://example.org/path/2',
            'http://example.org/path/4'
          ],
          path: 'http://example.org/foo'
        })
        .expect(200)
        .end((err, res) => {
          if (err) {
            return done(err);
          }

          res.body.should.be.an('array').of.length(6);
          res.body.should.have.nested.property('[0].author.name');

          done();
        });
    });

    it('should sort the result', () => {
      return new Promise((resolve, reject) => {
        request(app)
          .get('/api/mentions')
          .query({ path: 'http://example.org/path' })
          .expect(200)
          .end((err, res) => {
            if (err) {
              return reject(err);
            }

            res.body.should.be.an('array').and.satisfy(
              entries =>
                entries.reduce((previousValue, currentValue) => {
                  previousValue = previousValue.published || previousValue;
                  if (previousValue === false || previousValue >= currentValue.published) {
                    return false;
                  }
                  return currentValue.published;
                }) !== false,
              'Should sort by publish date, starting with the oldest one'
            );

            resolve();
          });
      });
    });

    it('should sort the result reversed when requested to', () => {
      return new Promise((resolve, reject) => {
        request(app)
          .get('/api/mentions')
          .query({ path: 'http://example.org/path', sort: 'desc' })
          .expect(200)
          .end((err, res) => {
            if (err) {
              return reject(err);
            }

            res.body.should.be.an('array').and.satisfy(
              entries =>
                entries.reduce((previousValue, currentValue) => {
                  previousValue = previousValue.published || previousValue;
                  if (previousValue !== undefined && (previousValue === false || previousValue <= currentValue.published)) {
                    return false;
                  }
                  return currentValue.published;
                }) !== false,
              'Should sort by publish date, starting with the newest one'
            );

            resolve();
          });
      });
    });

    it('should return in HTML when requested', (done) => {
      request(app)
        .get('/api/mentions')
        .query({ site: 'example.org', format: 'html' })
        .expect(200)
        .end((err, res) => {
          if (err) {
            return done(err);
          }

          done();
        });
    });
  });

  describe('live updates', () => {
    it.skip('should return data in an expected format');

    // Test the resolveDerivedData() method and use
    it.skip('should derive interaction target status correctly');
  });
});
