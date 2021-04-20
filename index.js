const sqlite3 = require("sqlite3");
const fastGlob = require("fast-glob");
const { join } = require("path");
const { readFile } = require("fs/promises");
const { PlistParser } = require("plist-parser");
const ical = require("node-ical");

const sourceDir = join(__dirname, "cal.icbu");

const db = new sqlite3.Database("db.sqlite");

/**
 * @param {string} query
 * @param  {...any} params
 * @returns {Promise<void>}
 */
function run(query, ...params) {
  return new Promise((resolve, reject) => {
    db.run(query, ...params, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {string} filename
 * @returns {Promise<ical.CalendarResponse>}
 */
function parseICSFile(filename) {
  return new Promise((resolve, reject) => {
    ical.parseFile(filename, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

async function main() {
  await run("DROP TABLE IF EXISTS calendar");
  await run("DROP TABLE IF EXISTS event");

  await run(`
  CREATE TABLE calendar (
    id TEXT PRIMARY KEY,
    title TEXT
  );
  `);

  await run(`
  CREATE TABLE event (
    id TEXT,
    calendarId TEXT,
    summary TEXT,
    description TEXT,
    location TEXT,
    dtstart DATETIME,
    dtend DATETIME,
    fullday BOOLEAN,
    transp TEXT,
    FOREIGN KEY(calendarId) REFERENCES calendar(id),
    PRIMARY KEY (id, calendarId)
  );
  `);

  const calendarDirectories = await fastGlob(
    join(sourceDir, "**", "*.calendar"),
    {
      onlyDirectories: true,
    }
  );

  /**
   * @param {string} file
   * @returns {Promise<any>}
   */
  async function readPlist(file) {
    const plist = await readFile(file, {
      encoding: "utf-8",
    });
    const plistParser = new PlistParser(plist);
    return plistParser.parse();
  }

  await Promise.all(
    calendarDirectories.map(async (calendarDirectory) => {
      let { Title, Key } = await readPlist(
        join(calendarDirectory, "Info.plist")
      );
      const calendarId = Key;

      /**
       * @param {'.caldav' | '.exchange'} type
       */
      async function prependFor(type) {
        if (calendarDirectory.includes(type)) {
          const caldavFolder = join(
            calendarDirectory.slice(
              0,
              calendarDirectory.indexOf(type) + type.length
            )
          );
          const CaldavTitle = (
            await readPlist(join(caldavFolder, "Info.plist"))
          ).Title;
          Title = CaldavTitle + " > " + Title;
        }
      }

      await prependFor(".caldav");
      await prependFor(".exchange");

      await run("INSERT INTO calendar(id, title) VALUES (?, ?)", [
        calendarId,
        Title,
      ]);

      const icsFiles = await fastGlob(
        join(calendarDirectory, "Events", "*.ics"),
        {
          onlyFiles: true,
        }
      );

      await Promise.all(
        icsFiles.map(async (icsFile) => {
          const response = await parseICSFile(icsFile);

          for (const event of Object.values(response)) {
            if (event.type !== "VEVENT") {
              continue;
            }

            if (!event.summary) {
              continue;
            }

            if (event.summary.val) {
              event.summary = event.summary.val;
            }

            await run(
              "INSERT OR IGNORE INTO event(id, calendarId, summary, description, location, dtstart, dtend, fullday, transp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                event.uid,
                calendarId,
                event.summary,
                event.description,
                event.location,
                event.start.toISOString(),
                event.end.toISOString(),
                event.start.dateOnly || false,
                event.transparency,
              ]
            );
          }
        })
      );
    })
  );
}

main();
