(() => {
    'use strict';

    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');
    const promisify = require('util').promisify;
    const writeFile = promisify(fs.writeFile);
    const readFile = promisify(fs.readFile);
    const fileStat = promisify(fs.stat);
    const mkdir = promisify(fs.mkdir);
    const unlink = promisify(fs.unlink);
    const stat = promisify(fs.stat);
    const _ = require('underscore');
    const jsdom = require('jsdom');
    const { JSDOM } = jsdom;
    const read = require('node-readability');
    const sanitizeHtml = require('sanitize-html');
    const download = require('download');
    const minify = require('html-minifier').minify;
    const exec = require('child_process').exec;
    const rimraf = require('rimraf');
    const showdown = require('showdown');
    const converter = new showdown.Converter();

    const maxImageSizeMb = 5;
    const bookFolderPath = path.join(process.cwd(), 'book');
    const mobiSupportedTags = [
        'a', 'address', 'article', 'aside', 'b', 'blockquote', 'body', 'br',
        'caption', 'center', 'cite', 'code', 'col', 'dd',
        'del', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
        'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'head', 'header', 'hgroup', 'hr', 'html', 'i', 'img', 'ins',
        'kbd', 'li', 'link', 'mark', 'map', 'menu', 'ol',
        'output', 'p', 'pre', 'q', 'rp', 'rt', 'samp', 'section',
        'small', 'source', 'span', 'strong', 'style', 'strike', 'sub',
        'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
        'title', 'tr', 'u', 'ul', 'var', 'wbr', 'nav', 'summary', 'details',
        'meta'
    ];


    function pad (value) {
        return (`00000${value}`).slice(-5);
    }

    function getTemplate (filename) {
        let fileName = `${filename}.tpl`;
        let filePath = path.join(__dirname, 'templates', fileName);

        return readFile(filePath, {
            encoding: 'UTF-8'
        });
    }

    async function checkContent (content, convertMarkdown = false) {
        content = content.toString();

        // convert markdown
        if (convertMarkdown) {
            content = converter.makeHtml(content);
        }

        // Save Images
        content = await extractImages(content);

        // remove not supported tags
        content = sanitizeHtml(content, {
            allowedTags      : mobiSupportedTags,
            allowedAttributes: {
                meta: [ 'charset' ],
                a   : [ 'href', 'name', 'target' ],
                img : [ 'src' ]
            }
        });

        // minify html
        content = minify(content, {
            collapseWhitespace   : true,
            preserveLineBreaks   : true,
            removeEmptyElements  : true,
            removeEmptyAttributes: true,
            removeAttributeQuotes: true,
            removeComments       : true,
            decodeEntities       : true
        });

        content = content.replace(/data-src/g, 'src');
        content = content.replace(/<source>/g, '<source/>');
        content = content.replace(/<img>/g, '');

        return content;
    }

    function readRemoteContent (url) {
        return new Promise((resolve, reject) => {
            read(url, { encoding: 'utf8' }, async (err, article, meta) => {
                if (err) reject(err);
                else {
                    await createFolder(bookFolderPath);

                    const content = article.content;
                    const dom = new JSDOM(content);

                    // add a utf8 header
                    dom.window.document.head.insertAdjacentHTML('beforeend', '<meta charset="utf-8">');

                    resolve(dom.serialize());
                    article.close();
                }
            });
        });
    }

    async function extractImages(content) {
        const dom = new JSDOM(content);
        // Images
        let imgs = dom.window.document.querySelectorAll('img');
        for (let img of imgs) {
            let extension, baseName, cleanedBaseName, cleanedFileName, src;
            if (img.src != null && img.src.trim() !== '') {
                src = img.src;
            } else if (img.srcset !== null && img.srcset.toLowerCase() !== 'null') {
                src = img.srcset.split(',')[0].split(' ')[0];
            }
            if (!src || !src.match(/\.(jpe?g|png|gif|bmp)$/i)) {
                img.remove();
                continue;
                // TODO: Can I figure out the type somehow?
            }

            extension = path.extname(src);
            baseName = path.basename(src, extension);
            cleanedBaseName = baseName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            cleanedFileName = cleanedBaseName + extension;
            console.log(`--> download image from: ${src}, rename to ${cleanedFileName}`);

            let imagePath = path.join(process.cwd(), 'book', cleanedFileName);
            await download(src, path.dirname(imagePath), { filename: cleanedFileName });
            let fstat = await stat(imagePath);
            // Limit image sizes since kindlegen might complain
            if (fstat.size / Math.pow(1024.0,2) > maxImageSizeMb) {
                img.remove();
                await unlink(imagePath);
            }

            // Handle HTML5 <picture>
            if (img.parentElement != null && img.parentElement.tagName.toLowerCase() === 'picture') {
                let temp = img.parentElement;
                temp.parentElement.insertBefore(img, temp);
            }
            img.src = cleanedFileName;
        }

        return dom.serialize();
    }

    function createFolder (fileFolder) {
        return checkIfFileExists(fileFolder, () => {
            return mkdir(fileFolder)
                .catch((err) => {
                    if (err.code !== 'EEXIST') {
                        throw Error(err);
                    }
                });
        });
    }

    function cleanupBookFolder () {
        return new Promise((resolve, reject) => {
            rimraf(bookFolderPath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    function createMobiFile (filename) {
        return new Promise((resolve, reject) => {
            let commands = [
                'cd ' + path.normalize(bookFolderPath),
                `${path.resolve(__dirname, '..', 'bin/kindlegen')} -c2 contents.opf -o ${filename}.mobi`
            ];

            let kindlegenExec = exec(commands.join(' && '));

            kindlegenExec.stdout.pipe(process.stdout);
            kindlegenExec.stderr.pipe(process.stderr);
            kindlegenExec.on('close', (code) => {
                console.log(`--> .mobi file created`);
                resolve();
            });
        });
    }

    async function checkIfFileExists (filePath, notExistCallback) {
        try {
            await fileStat(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw Error(err);
            }
            await notExistCallback();
        }
    }

    async function writeToBookFolder (fileName, fileContent) {
        assert.ok(fileName, 'no filename given');
        assert.ok(fileContent, 'no content given');

        // create folder if not exists
        await createFolder(bookFolderPath);

        return writeFile(path.join(bookFolderPath, fileName), fileContent, 'utf8');
    }

    async function copyCreatedMobi (fileName, targetFolder) {
        assert.ok(fileName, 'no fileName given');

        targetFolder = targetFolder || path.join(process.cwd(), 'compiled');
        let createdMobiPath = `${path.join(bookFolderPath, fileName)}.mobi`;
        let compiledMobiPath = `${path.join(targetFolder, fileName)}.mobi`;
        await copyFile(createdMobiPath, compiledMobiPath);
    }

    async function copyFile (sourceFilePath, targetFolder) {
        await createFolder(path.dirname(targetFolder));
        return new Promise((resolve, reject) => {
            let reader = fs.createReadStream(sourceFilePath);
            reader.pipe(fs.createWriteStream(targetFolder));
            reader.on('end', () => {
                console.log(`--> .mobi file copied`);
                resolve();
            });
            reader.on('error', () => {
                console.log(`--> .mobi file error`);
                reject();
            });
        });
    }

    async function createArticleHTMLFiles (article, articleNumber, sectionNumber) {
        try {
            assert.ok(typeof sectionNumber === 'number', 'sectionNumber is no number');
            assert.ok(typeof articleNumber === 'number', 'articleNumber is no number');

            let fileName = `${sectionNumber}-${pad(articleNumber)}.html`;

            let content = article.content || '';
            if (article.url) {
                content = await readRemoteContent(article.url);
            }
            if (article.file) {
                content = await readFile(article.file);
            }

            console.log(`-> create article (HTML) with Name ${fileName}`);
            const bom = '\ufeff';
            await createFolder(bookFolderPath);

            const cleanContent = await checkContent(content, article.convertMarkdown);

            await writeToBookFolder(fileName,  `${bom}${cleanContent}`);

            return fileName;
        } catch (err) {
            console.log('fail to create HTML for Article');
            throw Error(err);
        }
    }

    async function createSections (availableSections = []) {
        assert.ok(availableSections, 'no sections given');

        // get template data
        const $article = _.template(await getTemplate('content-article'));
        const $section = _.template(await getTemplate('content-section'));

        // prepare sections
        let sections = [];
        for (let sectionIndex in availableSections) {
            let currentSection = availableSections[sectionIndex];

            let articles = [];
            await Promise.all(currentSection.articles.map(async (article, articleIndex) => {
                let createdFileName = await createArticleHTMLFiles(article, articleIndex, parseInt(sectionIndex, 10));
                articles.push($article({
                    file : createdFileName,
                    title: article.title
                }));
            }));

            sections.push($section({
                title   : currentSection.title,
                articles: articles.join('')
            }));
        }

        return sections;
    }

    async function createContentHTMLFile (createdSections = []) {
        try {
            assert.ok(createdSections, 'no sections given');

            const $content = _.template(await getTemplate('content'));

            let fileName = `contents.html`;
            let fileContent = $content({
                sections: createdSections.join('')
            });

            console.log(`-> create contents (HTML) with Name ${fileName}`);
            await writeToBookFolder(fileName, fileContent);

            return fileName;
        } catch (err) {
            console.log('fail to create content html');
            throw Error(err);
        }
    }

    async function createOpfHTMLFile (params = {}) {
        try {
            assert.ok(params, 'no params given');

            const $opf = _.template(await getTemplate('opf'));
            const $opfManifest = _.template(await getTemplate('opf-manifest'));
            const $opfSpineItem = _.template(await getTemplate('opf-spine-item'));

            const manifestItems = [];
            const refItems = [];

            for (let sectionIndex in params.sections) {
                let currentSection = params.sections[sectionIndex];
                for (let articleIndex in currentSection.articles) {
                    let fileName = `${sectionIndex}-${pad(articleIndex)}`;
                    let idrefName = `item-${fileName}`;
                    manifestItems.push($opfManifest({
                        href : `${fileName}.html`,
                        media: 'application/xhtml+xml',
                        idref: idrefName
                    }));

                    refItems.push($opfSpineItem({
                        idref: idrefName
                    }));
                }
            }

            let currentDate = Date.now();
            let dateString = new Date();
            dateString = dateString.getFullYear() + '-' + (dateString.getMonth() + 1) + '-' + dateString.getDay();

            let cover = '';
            if (params.cover) {
                cover = path.basename(params.cover);
            }


            let fileName = 'contents.opf';
            console.log(`-> create opf (HTML) with Name ${fileName}`);
            await writeToBookFolder(fileName, $opf({
                doc_uuid      : currentDate,
                title         : params.title,
                author        : params.creator,
                cover         : cover,
                publisher     : params.publisher,
                subject       : params.subject,
                language      : params.language || 'en-gb',
                date          : dateString,
                description   : params.description,
                manifest_items: manifestItems.join(''),
                spine_items   : refItems.join('')
            }));

            return fileName;
        } catch (err) {
            console.log('fail to create opf html file');
            throw Error(err);
        }
    }

    async function createNsxHTMLFile (params = {}) {
        assert.ok(params, 'no params given');

        const $ncx = _.template(await getTemplate('ncx'));
        const $ncxArticle = _.template(await getTemplate('ncx-article'));
        const $ncxSection = _.template(await getTemplate('ncx-section'));

        var sections = [];
        for (let sectionIndex in params.sections) {
            let currentSection = params.sections[sectionIndex];
            let sectionFirst = sectionIndex;

            let articles = [];
            for (let articleIndex in currentSection.articles) {
                let currentArticle = currentSection.articles[articleIndex];

                articles.push($ncxArticle({
                    playorder  : sectionIndex,
                    idref      : sectionIndex,
                    short_title: currentArticle.title,
                    href       : `${sectionIndex}-${pad(articleIndex)}.html`,
                    description: currentArticle.title,
                    author     : currentArticle.author
                }));
            }

            if (articles.length !== 0) {
                sections.push($ncxSection({
                    playorder: sectionFirst,
                    idref    : `sectionid-${sectionIndex}`,
                    title    : currentSection.title,
                    href     : `${sectionIndex}-${pad(0)}.html`, // ?
                    articles : articles.join('')
                }));
            }
        }

        let fileName = 'nav-contents.ncx';
        console.log(`-> create ncx (HTML) with Name ${fileName}`);
        writeToBookFolder(fileName, $ncx({
            title   : params.title,
            author  : params.creator,
            sections: sections.join('')
        }));

        return fileName;
    }

    exports.create = async function (params = {}, opts = {}) {
        try {
            assert.ok(params.title, 'no title given');
            assert.ok(params.sections, 'no sections given');

            await cleanupBookFolder();

            if (params.cover) {
                await copyFile(params.cover, path.join(bookFolderPath, path.basename(params.cover)));
            }

            let createdSections = await createSections(params.sections);
            await createContentHTMLFile(createdSections);
            await createOpfHTMLFile(params);
            await createNsxHTMLFile(params);

            let filename = opts.filename || params.title.replace(' ', '');
            await createMobiFile(filename);
            await copyCreatedMobi(filename, opts.targetFolder);

            return true;
        } catch (err) {
            console.log('fail to create .mobi');
            throw Error(err);
        }
    };
})();
