/*jslint node: true, white: true, indent: 2 */

"use strict";

module.exports = function (grunt) {
  var indentLines = function (src) {
    return src.split('\n').map(function (line) {
      return line ? '  ' + line : line;
    }).join('\n');
  };

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    jshint: {
      files: [
        'Gruntfile.js',
        'lib/**/*.js',
        'migrations/**/*.js',
        'theme/*.js',
        'theme/sources/js/**/*.js',
        '!theme/sources/js/vendor/**/*.js',
        'test/**/*.js'
      ],
      options: { jshintrc: '.jshintrc' }
    },
    lintspaces: {
      files: ['<%= jshint.files %>'],
      options: { editorconfig: '.editorconfig' }
    },
    mocha_istanbul: {
      options: {
        root: './lib',
        mask: '**/*.spec.js'
      },
      unit: {
        src: 'test/unit'
      },
      basic: {
        src: 'test'
      },
      coveralls: {
        src: 'test',
        options: {
          coverage: true,
          reportFormats: ['lcovonly']
        }
      }
    },
    concat: {
      options: {
        separator: ';'
      },
      web: {
        src: [
          'theme/sources/js/vendor/jquery.js',
          'theme/sources/js/script.js',
        ],
        dest: 'theme/public/js/script.js'
      },
      cuttingEdgeAjax: {
        options: {
          banner: '(function () {\n',
          footer: '\n  window.VPWebMentionEndpoint = publicMethods;\n  findNewInjectionPoints();\n}());\n',
          process: indentLines,
        },
        src: ['theme/sources/js/cutting-edge.js'],
        dest: 'theme/public/js/cutting-edge.js'
      },
      // cuttingEdgeTemplate: {
      //   options: {
      //     banner: '(function (mentions, interactions, options) {\n',
      //     footer: '}(\\<%= JSON.stringify(mentions) %\\>, \\<%= JSON.stringify(interactions) %\\>, \\<%= JSON.stringify(options) %\\>));\n',
      //     process: indentLines,
      //   },
      //   src: ['theme/sources/js/cutting-edge.js'],
      //   dest: 'theme/templates/cutting-edge-embed.html'
      // }
    },
    uglify: {
      dist: {
        files: {
          'theme/public/js/script.js': ['theme/public/js/script.js'],
          'theme/public/js/cutting-edge.js': ['theme/public/js/cutting-edge.js'],
        }
      }
    },
    watch: {
      jshint : {
        files: ['<%= jshint.files %>'],
        tasks: ['default'],
      }
    }
  });

  grunt.loadNpmTasks('grunt-notify');
  grunt.loadNpmTasks('grunt-lintspaces');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-watch');
  grunt.loadNpmTasks('grunt-mocha-istanbul');

  grunt.registerTask('setTestEnv', 'Ensure that environment (database etc) is set up for testing', function () {
    process.env.NODE_ENV = 'test';
  });

  grunt.registerTask('build-dev', ['concat']);
  grunt.registerTask('build',     ['concat', 'uglify']);

  grunt.registerTask('travis',    ['lintspaces', 'jshint', 'setTestEnv', 'mocha_istanbul:coveralls']);
  grunt.registerTask('test',      ['lintspaces', 'jshint', 'setTestEnv', 'mocha_istanbul:basic']);
  grunt.registerTask('fast-test', ['lintspaces', 'jshint', 'setTestEnv', 'mocha_istanbul:unit']);

  grunt.registerTask('default',   ['build-dev', 'test']);


  grunt.event.on('coverage', function(lcov, done){
    require('coveralls').handleInput(lcov, function(err){
      if (err) {
        return done(err);
      }
      done();
    });
  });
};
