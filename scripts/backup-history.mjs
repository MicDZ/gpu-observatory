#!/usr/bin/env node
// SQLite's online backup API includes committed WAL data; a raw file copy does not.
import {DatabaseSync,backup} from 'node:sqlite';
import {resolve} from 'node:path';
import {statSync,openSync,closeSync,chmodSync,unlinkSync} from 'node:fs';
const [sourceArg,targetArg]=process.argv.slice(2);
if(!sourceArg||!targetArg){console.error('Usage: node scripts/backup-history.mjs SOURCE.sqlite NEW-BACKUP.sqlite');process.exit(1);}
const source=resolve(sourceArg),target=resolve(targetArg);let db,created=false;
try{
  if(source===target||!statSync(source).isFile())throw Error('Invalid paths');
  db=new DatabaseSync(source,{readOnly:true});
  closeSync(openSync(target,'wx',0o600));created=true;
  await backup(db,target);chmodSync(target,0o600);
  console.log('Private, consistent SQLite backup completed. Existing backups were not overwritten.');
}catch(error){if(created)unlinkSync(target);console.error('Backup failed. Check paths, runtime version and available space. Source data was not changed.');process.exitCode=1;}
finally{db?.close();}
