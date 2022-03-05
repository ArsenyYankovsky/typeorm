import {ObjectLiteral} from "../../common/ObjectLiteral";
import {QueryFailedError} from "../../error/QueryFailedError";
import {QueryRunnerAlreadyReleasedError} from "../../error/QueryRunnerAlreadyReleasedError";
import {TransactionNotStartedError} from "../../error/TransactionNotStartedError";
import {ColumnType} from "../types/ColumnTypes";
import {ReadStream} from "../../platform/PlatformTools";
import {BaseQueryRunner} from "../../query-runner/BaseQueryRunner";
import {QueryRunner} from "../../query-runner/QueryRunner";
import {TableIndexOptions} from "../../schema-builder/options/TableIndexOptions";
import {Table} from "../../schema-builder/table/Table";
import {TableCheck} from "../../schema-builder/table/TableCheck";
import {TableColumn} from "../../schema-builder/table/TableColumn";
import {TableExclusion} from "../../schema-builder/table/TableExclusion";
import {TableForeignKey} from "../../schema-builder/table/TableForeignKey";
import {TableIndex} from "../../schema-builder/table/TableIndex";
import {TableUnique} from "../../schema-builder/table/TableUnique";
import {View} from "../../schema-builder/view/View";
import {Broadcaster} from "../../subscriber/Broadcaster";
import {OrmUtils} from "../../util/OrmUtils";
import {Query} from "../Query";
import {IsolationLevel} from "../types/IsolationLevel";
import {ReplicationMode} from "../types/ReplicationMode";
import {TypeORMError} from "../../error";
import {QueryResult} from "../../query-runner/QueryResult";
import {MetadataTableType} from "../types/MetadataTableType";
import {SpannerDriver} from "./SpannerDriver";

/**
 * Runs queries on a single postgres database connection.
 */
export class SpannerQueryRunner extends BaseQueryRunner implements QueryRunner {

    // -------------------------------------------------------------------------
    // Public Implemented Properties
    // -------------------------------------------------------------------------

    /**
     * Database driver used by connection.
     */
    driver: SpannerDriver;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(driver: SpannerDriver, mode: ReplicationMode) {
        super();
        this.driver = driver;
        this.connection = driver.connection;
        this.mode = mode;
        this.broadcaster = new Broadcaster(this);
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Creates/uses database connection from the connection pool to perform further operations.
     * Returns obtained database connection.
     */
    async connect(): Promise<any> {
        if (this.databaseConnection)
            return Promise.resolve(this.databaseConnection);

        return this.driver.instance.database(this.driver.options.databaseId);
    }

    /**
     * Releases used database connection.
     * You cannot use query runner methods once its released.
     */
    async release(): Promise<void> {
        if (this.databaseConnection)
            return this.databaseConnection.close()
    }

    /**
     * Starts transaction.
     */
    async startTransaction(isolationLevel?: IsolationLevel): Promise<void> {
        this.isTransactionActive = true;
        try {
            await this.broadcaster.broadcast('BeforeTransactionStart');
        } catch (err) {
            this.isTransactionActive = false;
            throw err;
        }

        // if (this.transactionDepth === 0) {
        //     await this.query("START TRANSACTION");
        //     if (isolationLevel) {
        //         await this.query("SET TRANSACTION ISOLATION LEVEL " + isolationLevel);
        //     }
        // } else {
        //     await this.query(`SAVEPOINT typeorm_${this.transactionDepth}`);
        // }
        // this.transactionDepth += 1;

        await this.broadcaster.broadcast('AfterTransactionStart');
    }

    /**
     * Commits transaction.
     * Error will be thrown if transaction was not started.
     */
    async commitTransaction(): Promise<void> {
        if (!this.isTransactionActive)
            throw new TransactionNotStartedError();

        await this.broadcaster.broadcast('BeforeTransactionCommit');

        // if (this.transactionDepth > 1) {
        //     await this.query(`RELEASE SAVEPOINT typeorm_${this.transactionDepth - 1}`);
        // } else {
        //     await this.query("COMMIT");
        //     this.isTransactionActive = false;
        // }
        // this.transactionDepth -= 1;

        await this.broadcaster.broadcast('AfterTransactionCommit');
    }

    /**
     * Rollbacks transaction.
     * Error will be thrown if transaction was not started.
     */
    async rollbackTransaction(): Promise<void> {
        if (!this.isTransactionActive)
            throw new TransactionNotStartedError();

        await this.broadcaster.broadcast('BeforeTransactionRollback');

        // if (this.transactionDepth > 1) {
        //     await this.query(`ROLLBACK TO SAVEPOINT typeorm_${this.transactionDepth - 1}`);
        // } else {
        //     await this.query("ROLLBACK");
        //     this.isTransactionActive = false;
        // }
        // this.transactionDepth -= 1;

        await this.broadcaster.broadcast('AfterTransactionRollback');
    }

    /**
     * Executes a given SQL query.
     */
    async query(query: string, parameters?: any[], useStructuredResult: boolean = false): Promise<any> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        this.databaseConnection = await this.connect();

        this.driver.connection.logger.logQuery(query, parameters, this);
        try {
            const queryStartTime = +new Date();
            const [rows] = await this.databaseConnection.run({
                sql: query,
                params: parameters,
                json: true
            });
            console.log("rows", rows);
            // log slow queries if maxQueryExecution time is set
            const maxQueryExecutionTime = this.driver.options.maxQueryExecutionTime;
            const queryEndTime = +new Date();
            const queryExecutionTime = queryEndTime - queryStartTime;
            if (maxQueryExecutionTime && queryExecutionTime > maxQueryExecutionTime)
                this.driver.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this);

            const result = new QueryResult();

            result.raw = rows;
            result.records = rows

            if (!useStructuredResult) {
                return result.raw;
            }

            return result;
        } catch (err) {
            this.driver.connection.logger.logQueryError(err, query, parameters, this);
            throw new QueryFailedError(query, parameters, err);
        }
    }

    /**
     * Update database schema.
     * Used for creating/altering/dropping tables, columns, indexes, etc.
     *
     * DDL changing queries should be executed by `updateSchema()` method.
     */
    async updateDDL(query: string, parameters?: any[]): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        this.databaseConnection = await this.connect();

        this.driver.connection.logger.logQuery(query, parameters, this);
        try {
            const queryStartTime = +new Date();
            const [operation] = await this.databaseConnection.updateSchema(query);
            await operation.promise()
            // log slow queries if maxQueryExecution time is set
            const maxQueryExecutionTime = this.driver.options.maxQueryExecutionTime;
            const queryEndTime = +new Date();
            const queryExecutionTime = queryEndTime - queryStartTime;
            if (maxQueryExecutionTime && queryExecutionTime > maxQueryExecutionTime)
                this.driver.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this);

        } catch (err) {
            this.driver.connection.logger.logQueryError(err, query, parameters, this);
            throw new QueryFailedError(query, parameters, err);
        }
    }

    /**
     * Returns raw data stream.
     */
    async stream(query: string, parameters?: any[], onEnd?: Function, onError?: Function): Promise<ReadStream> {
        throw new Error(`Streams are not supported`)
    }

    /**
     * Returns all available database names including system databases.
     */
    async getDatabases(): Promise<string[]> {
        return Promise.resolve([]);
    }

    /**
     * Returns all available schema names including system schemas.
     * If database parameter specified, returns schemas of that database.
     */
    async getSchemas(database?: string): Promise<string[]> {
        return Promise.resolve([]);
    }

    /**
     * Checks if database with the given name exist.
     */
    async hasDatabase(database: string): Promise<boolean> {
        const result = await this.query(`SELECT * FROM pg_database WHERE datname='${database}';`);
        return result.length ? true : false;
    }

    /**
     * Loads currently using database
     */
    async getCurrentDatabase(): Promise<string> {
        throw new TypeORMError(`Check database queries are not supported by Spanner driver.`);
    }

    /**
     * Checks if schema with the given name exist.
     */
    async hasSchema(schema: string): Promise<boolean> {
        const result = await this.query(`SELECT * FROM "information_schema"."schemata" WHERE "schema_name" = '${schema}'`);
        return result.length ? true : false;
    }

    /**
     * Loads currently using database schema
     */
    async getCurrentSchema(): Promise<string> {
        throw new TypeORMError(`Check schema queries are not supported by Spanner driver.`);
    }

    /**
     * Checks if table with the given name exist in the database.
     */
    async hasTable(tableOrName: Table|string): Promise<boolean> {
        const tableName = tableOrName instanceof Table ? tableOrName.name : tableOrName
        const sql = `SELECT * FROM \`INFORMATION_SCHEMA\`.\`TABLES\` ` +
            `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' ` +
            `AND \`TABLE_NAME\` = '${tableName}'`;
        const result = await this.query(sql);
        return result.length ? true : false;
    }

    /**
     * Checks if column with the given name exist in the given table.
     */
    async hasColumn(tableOrName: Table|string, columnName: string): Promise<boolean> {
        const tableName = tableOrName instanceof Table ? tableOrName.name : tableOrName
        const sql = `SELECT * FROM \`INFORMATION_SCHEMA\`.\`TABLES\` ` +
            `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' ` +
            `AND \`TABLE_NAME\` = '${tableName}' AND \`COLUMN_NAME\` = ${columnName}`;
        const result = await this.query(sql);
        return result.length ? true : false;
    }

    /**
     * Creates a new database.
     * Note: Spanner does not support database creation inside a transaction block.
     */
    async createDatabase(database: string, ifNotExist?: boolean): Promise<void> {
        if (ifNotExist) {
            const databaseAlreadyExists = await this.hasDatabase(database);

            if (databaseAlreadyExists)
                return Promise.resolve();
        }

        const up = `CREATE DATABASE "${database}"`;
        const down = `DROP DATABASE "${database}"`;
        await this.executeQueries(new Query(up), new Query(down));
    }

    /**
     * Drops database.
     * Note: Spanner does not support database dropping inside a transaction block.
     */
    async dropDatabase(database: string, ifExist?: boolean): Promise<void> {
        const up = ifExist ? `DROP DATABASE IF EXISTS "${database}"` : `DROP DATABASE "${database}"`;
        const down = `CREATE DATABASE "${database}"`;
        await this.executeQueries(new Query(up), new Query(down));
    }

    /**
     * Creates a new table schema.
     */
    async createSchema(schemaPath: string, ifNotExist?: boolean): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Drops table schema.
     */
    async dropSchema(schemaPath: string, ifExist?: boolean, isCascade?: boolean): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Creates a new table.
     */
    async createTable(table: Table, ifNotExist: boolean = false, createForeignKeys: boolean = true, createIndices: boolean = true): Promise<void> {
        if (ifNotExist) {
            const isTableExist = await this.hasTable(table);
            if (isTableExist) return Promise.resolve();
        }
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];

        // // if table have column with ENUM type, we must create this type in postgres.
        // const enumColumns = table.columns.filter(column => column.type === "enum" || column.type === "simple-enum")
        // const createdEnumTypes: string[] = []
        // for (const column of enumColumns) {
        //     // TODO: Should also check if values of existing type matches expected ones
        //     const hasEnum = await this.hasEnumType(table, column);
        //     const enumName = this.buildEnumName(table, column)
        //
        //     // if enum with the same "enumName" is defined more then once, me must prevent double creation
        //     if (!hasEnum && createdEnumTypes.indexOf(enumName) === -1) {
        //         createdEnumTypes.push(enumName)
        //         upQueries.push(this.createEnumTypeSql(table, column, enumName));
        //         downQueries.push(this.dropEnumTypeSql(table, column, enumName));
        //     }
        // }

        // if table have column with generated type, we must add the expression to the metadata table
        // const generatedColumns = table.columns.filter(column => column.generatedType === "STORED" && column.asExpression)
        // for (const column of generatedColumns) {
        //     const tableNameWithSchema = (await this.getTableNameWithSchema(table.name)).split('.');
        //     const tableName = tableNameWithSchema[1];
        //     const schema = tableNameWithSchema[0];
        //
        //     const insertQuery = this.insertTypeormMetadataSql({
        //         database: this.driver.database,
        //         schema,
        //         table: tableName,
        //         type: MetadataTableType.GENERATED_COLUMN,
        //         name: column.name,
        //         value: column.asExpression
        //     })
        //
        //     const deleteQuery = this.deleteTypeormMetadataSql({
        //         database: this.driver.database,
        //         schema,
        //         table: tableName,
        //         type: MetadataTableType.GENERATED_COLUMN,
        //         name: column.name
        //     })
        //
        //     upQueries.push(deleteQuery);
        //     upQueries.push(insertQuery);
        //     downQueries.push(deleteQuery);
        // }

        upQueries.push(this.createTableSql(table, createForeignKeys));
        downQueries.push(this.dropTableSql(table));

        // if createForeignKeys is true, we must drop created foreign keys in down query.
        // createTable does not need separate method to create foreign keys, because it create fk's in the same query with table creation.
        if (createForeignKeys)
            table.foreignKeys.forEach(foreignKey => downQueries.push(this.dropForeignKeySql(table, foreignKey)));

        if (createIndices) {
            table.indices.forEach(index => {

                // new index may be passed without name. In this case we generate index name manually.
                if (!index.name)
                    index.name = this.connection.namingStrategy.indexName(table, index.columnNames, index.where);
                upQueries.push(this.createIndexSql(table, index));
                downQueries.push(this.dropIndexSql(table, index));
            });
        }

        await this.executeQueries(upQueries, downQueries);
    }

    /**
     * Drops the table.
     */
    async dropTable(target: Table|string, ifExist?: boolean, dropForeignKeys: boolean = true, dropIndices: boolean = true): Promise<void> {// It needs because if table does not exist and dropForeignKeys or dropIndices is true, we don't need
        // to perform drop queries for foreign keys and indices.
        if (ifExist) {
            const isTableExist = await this.hasTable(target);
            if (!isTableExist) return Promise.resolve();
        }

        // if dropTable called with dropForeignKeys = true, we must create foreign keys in down query.
        const createForeignKeys: boolean = dropForeignKeys;
        const tablePath = this.getTablePath(target);
        const table = await this.getCachedTable(tablePath);
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];


        if (dropIndices) {
            table.indices.forEach(index => {
                upQueries.push(this.dropIndexSql(table, index));
                downQueries.push(this.createIndexSql(table, index));
            });
        }

        if (dropForeignKeys)
            table.foreignKeys.forEach(foreignKey => upQueries.push(this.dropForeignKeySql(table, foreignKey)));

        upQueries.push(this.dropTableSql(table));
        downQueries.push(this.createTableSql(table, createForeignKeys));

        await this.executeQueries(upQueries, downQueries);
    }

    /**
     * Creates a new view.
     */
    async createView(view: View): Promise<void> {
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];
        upQueries.push(this.createViewSql(view));
        upQueries.push(await this.insertViewDefinitionSql(view));
        downQueries.push(this.dropViewSql(view));
        downQueries.push(await this.deleteViewDefinitionSql(view));
        await this.executeQueries(upQueries, downQueries);
    }

    /**
     * Drops the view.
     */
    async dropView(target: View|string): Promise<void> {
        const viewName = target instanceof View ? target.name : target;
        const view = await this.getCachedView(viewName);

        const upQueries: Query[] = [];
        const downQueries: Query[] = [];
        upQueries.push(await this.deleteViewDefinitionSql(view));
        upQueries.push(this.dropViewSql(view));
        downQueries.push(await this.insertViewDefinitionSql(view));
        downQueries.push(this.createViewSql(view));
        await this.executeQueries(upQueries, downQueries);
    }

    /**
     * Renames the given table.
     */
    async renameTable(oldTableOrName: Table|string, newTableName: string): Promise<void> {
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];
        const oldTable = oldTableOrName instanceof Table ? oldTableOrName : await this.getCachedTable(oldTableOrName);
        const newTable = oldTable.clone();

        const { schema: schemaName, tableName: oldTableName } = this.driver.parseTableName(oldTable);

        newTable.name = schemaName ? `${schemaName}.${newTableName}` : newTableName;

        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(oldTable)} RENAME TO "${newTableName}"`));
        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME TO "${oldTableName}"`));

        // rename column primary key constraint
        if (newTable.primaryColumns.length > 0) {
            const columnNames = newTable.primaryColumns.map(column => column.name);

            const oldPkName = this.connection.namingStrategy.primaryKeyName(oldTable, columnNames);
            const newPkName = this.connection.namingStrategy.primaryKeyName(newTable, columnNames);

            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${oldPkName}" TO "${newPkName}"`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${newPkName}" TO "${oldPkName}"`));
        }

        // rename sequences
        newTable.columns.map(col => {
            if (col.isGenerated && col.generationStrategy === "increment") {
                const sequencePath = this.buildSequencePath(oldTable, col.name);
                const sequenceName = this.buildSequenceName(oldTable, col.name);

                const newSequencePath = this.buildSequencePath(newTable, col.name);
                const newSequenceName = this.buildSequenceName(newTable, col.name);

                const up = `ALTER SEQUENCE ${this.escapePath(sequencePath)} RENAME TO "${newSequenceName}"`;
                const down = `ALTER SEQUENCE ${this.escapePath(newSequencePath)} RENAME TO "${sequenceName}"`;

                upQueries.push(new Query(up));
                downQueries.push(new Query(down));
            }
        });

        // rename unique constraints
        newTable.uniques.forEach(unique => {
            // build new constraint name
            const newUniqueName = this.connection.namingStrategy.uniqueConstraintName(newTable, unique.columnNames);

            // build queries
            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${unique.name}" TO "${newUniqueName}"`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${newUniqueName}" TO "${unique.name}"`));

            // replace constraint name
            unique.name = newUniqueName;
        });

        // rename index constraints
        newTable.indices.forEach(index => {
            // build new constraint name
            const { schema } = this.driver.parseTableName(newTable);
            const newIndexName = this.connection.namingStrategy.indexName(newTable, index.columnNames, index.where);

            // build queries
            const up = schema ? `ALTER INDEX "${schema}"."${index.name}" RENAME TO "${newIndexName}"` : `ALTER INDEX "${index.name}" RENAME TO "${newIndexName}"`;
            const down = schema ? `ALTER INDEX "${schema}"."${newIndexName}" RENAME TO "${index.name}"` : `ALTER INDEX "${newIndexName}" RENAME TO "${index.name}"`;
            upQueries.push(new Query(up));
            downQueries.push(new Query(down));

            // replace constraint name
            index.name = newIndexName;
        });

        // rename foreign key constraints
        newTable.foreignKeys.forEach(foreignKey => {
            // build new constraint name
            const newForeignKeyName = this.connection.namingStrategy.foreignKeyName(newTable, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);

            // build queries
            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${foreignKey.name}" TO "${newForeignKeyName}"`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${newForeignKeyName}" TO "${foreignKey.name}"`));

            // replace constraint name
            foreignKey.name = newForeignKeyName;
        });

        // rename ENUM types
        const enumColumns = newTable.columns.filter(column => column.type === "enum" || column.type === "simple-enum");
        for (let column of enumColumns) {
            // skip renaming for user-defined enum name
            if (column.enumName) continue;

            const oldEnumType = await this.getUserDefinedTypeName(oldTable, column);
            upQueries.push(new Query(`ALTER TYPE "${oldEnumType.schema}"."${oldEnumType.name}" RENAME TO ${this.buildEnumName(newTable, column, false)}`));
            downQueries.push(new Query(`ALTER TYPE ${this.buildEnumName(newTable, column)} RENAME TO "${oldEnumType.name}"`));
        }
        await this.executeQueries(upQueries, downQueries);
    }

    /**
     * Creates a new column from the column in the table.
     */
    async addColumn(tableOrName: Table|string, column: TableColumn): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];

        if (column.type === "enum" || column.type === "simple-enum") {
            const hasEnum = await this.hasEnumType(table, column);
            if (!hasEnum) {
                upQueries.push(this.createEnumTypeSql(table, column));
                downQueries.push(this.dropEnumTypeSql(table, column));
            }
        }

        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD ${this.buildCreateColumnSql(column)}`));
        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP COLUMN "${column.name}"`));

        // create or update primary key constraint
        if (column.isPrimary) {
            const primaryColumns = clonedTable.primaryColumns;
            // if table already have primary key, me must drop it and recreate again
            if (primaryColumns.length > 0) {
                const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map(column => column.name));
                const columnNames = primaryColumns.map(column => `"${column.name}"`).join(", ");
                upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
            }

            primaryColumns.push(column);
            const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map(column => column.name));
            const columnNames = primaryColumns.map(column => `"${column.name}"`).join(", ");
            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
        }

        // create column index
        const columnIndex = clonedTable.indices.find(index => index.columnNames.length === 1 && index.columnNames[0] === column.name);
        if (columnIndex) {
            upQueries.push(this.createIndexSql(table, columnIndex));
            downQueries.push(this.dropIndexSql(table, columnIndex));
        }

        // create unique constraint
        if (column.isUnique) {
            const uniqueConstraint = new TableUnique({
                name: this.connection.namingStrategy.uniqueConstraintName(table, [column.name]),
                columnNames: [column.name]
            });
            clonedTable.uniques.push(uniqueConstraint);
            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE ("${column.name}")`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueConstraint.name}"`));
        }

        if (column.generatedType === "STORED" && column.asExpression) {
            const tableNameWithSchema = (await this.getTableNameWithSchema(table.name)).split('.');
            const tableName = tableNameWithSchema[1];
            const schema = tableNameWithSchema[0];

            const insertQuery = this.insertTypeormMetadataSql({
                database: this.driver.database,
                schema,
                table: tableName,
                type: MetadataTableType.GENERATED_COLUMN,
                name: column.name,
                value: column.asExpression
            })

            const deleteQuery = this.deleteTypeormMetadataSql({
                database: this.driver.database,
                schema,
                table: tableName,
                type: MetadataTableType.GENERATED_COLUMN,
                name: column.name
            })

            upQueries.push(deleteQuery);
            upQueries.push(insertQuery);
            downQueries.push(deleteQuery);
        }

        // create column's comment
        if (column.comment) {
            upQueries.push(new Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${column.name}" IS ${this.escapeComment(column.comment)}`));
            downQueries.push(new Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${column.name}" IS ${this.escapeComment(column.comment)}`));
        }

        await this.executeQueries(upQueries, downQueries);

        clonedTable.addColumn(column);
        this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Creates a new columns from the column in the table.
     */
    async addColumns(tableOrName: Table|string, columns: TableColumn[]): Promise<void> {
        for (const column of columns) {
            await this.addColumn(tableOrName, column);
        }
    }

    /**
     * Renames column in the given table.
     */
    async renameColumn(tableOrName: Table|string, oldTableColumnOrName: TableColumn|string, newTableColumnOrName: TableColumn|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const oldColumn = oldTableColumnOrName instanceof TableColumn ? oldTableColumnOrName : table.columns.find(c => c.name === oldTableColumnOrName);
        if (!oldColumn)
            throw new TypeORMError(`Column "${oldTableColumnOrName}" was not found in the "${table.name}" table.`);

        let newColumn;
        if (newTableColumnOrName instanceof TableColumn) {
            newColumn = newTableColumnOrName;
        } else {
            newColumn = oldColumn.clone();
            newColumn.name = newTableColumnOrName;
        }

        return this.changeColumn(table, oldColumn, newColumn);
    }

    /**
     * Changes a column in the table.
     */
    async changeColumn(tableOrName: Table|string, oldTableColumnOrName: TableColumn|string, newColumn: TableColumn): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        let clonedTable = table.clone();
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];
        let defaultValueChanged = false

        const oldColumn = oldTableColumnOrName instanceof TableColumn
            ? oldTableColumnOrName
            : table.columns.find(column => column.name === oldTableColumnOrName);
        if (!oldColumn)
            throw new TypeORMError(`Column "${oldTableColumnOrName}" was not found in the "${table.name}" table.`);


        if (oldColumn.type !== newColumn.type
            || oldColumn.length !== newColumn.length
            || newColumn.isArray !== oldColumn.isArray
            || (!oldColumn.generatedType && newColumn.generatedType === "STORED")
            || (oldColumn.asExpression !== newColumn.asExpression && newColumn.generatedType === "STORED")) {
            // To avoid data conversion, we just recreate column
            await this.dropColumn(table, oldColumn);
            await this.addColumn(table, newColumn);

            // update cloned table
            clonedTable = table.clone();

        } else {
            if (oldColumn.name !== newColumn.name) {
                // rename column
                upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME COLUMN "${oldColumn.name}" TO "${newColumn.name}"`));
                downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME COLUMN "${newColumn.name}" TO "${oldColumn.name}"`));

                // rename ENUM type
                if (oldColumn.type === "enum" || oldColumn.type === "simple-enum") {
                    const oldEnumType = await this.getUserDefinedTypeName(table, oldColumn);
                    upQueries.push(new Query(`ALTER TYPE "${oldEnumType.schema}"."${oldEnumType.name}" RENAME TO ${this.buildEnumName(table, newColumn, false)}`));
                    downQueries.push(new Query(`ALTER TYPE ${this.buildEnumName(table, newColumn)} RENAME TO "${oldEnumType.name}"`));
                }

                // rename column primary key constraint
                if (oldColumn.isPrimary === true) {
                    const primaryColumns = clonedTable.primaryColumns;

                    // build old primary constraint name
                    const columnNames = primaryColumns.map(column => column.name);
                    const oldPkName = this.connection.namingStrategy.primaryKeyName(clonedTable, columnNames);

                    // replace old column name with new column name
                    columnNames.splice(columnNames.indexOf(oldColumn.name), 1);
                    columnNames.push(newColumn.name);

                    // build new primary constraint name
                    const newPkName = this.connection.namingStrategy.primaryKeyName(clonedTable, columnNames);

                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${oldPkName}" TO "${newPkName}"`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${newPkName}" TO "${oldPkName}"`));
                }

                // rename column sequence
                if (oldColumn.isGenerated === true && newColumn.generationStrategy === "increment") {
                    const sequencePath = this.buildSequencePath(table, oldColumn.name);
                    const sequenceName = this.buildSequenceName(table, oldColumn.name);

                    const newSequencePath = this.buildSequencePath(table, newColumn.name);
                    const newSequenceName = this.buildSequenceName(table, newColumn.name);

                    const up = `ALTER SEQUENCE ${this.escapePath(sequencePath)} RENAME TO "${newSequenceName}"`;
                    const down = `ALTER SEQUENCE ${this.escapePath(newSequencePath)} RENAME TO "${sequenceName}"`;
                    upQueries.push(new Query(up));
                    downQueries.push(new Query(down));
                }

                // rename unique constraints
                clonedTable.findColumnUniques(oldColumn).forEach(unique => {
                    // build new constraint name
                    unique.columnNames.splice(unique.columnNames.indexOf(oldColumn.name), 1);
                    unique.columnNames.push(newColumn.name);
                    const newUniqueName = this.connection.namingStrategy.uniqueConstraintName(clonedTable, unique.columnNames);

                    // build queries
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${unique.name}" TO "${newUniqueName}"`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${newUniqueName}" TO "${unique.name}"`));

                    // replace constraint name
                    unique.name = newUniqueName;
                });

                // rename index constraints
                clonedTable.findColumnIndices(oldColumn).forEach(index => {
                    // build new constraint name
                    index.columnNames.splice(index.columnNames.indexOf(oldColumn.name), 1);
                    index.columnNames.push(newColumn.name);
                    const { schema } = this.driver.parseTableName(table);
                    const newIndexName = this.connection.namingStrategy.indexName(clonedTable, index.columnNames, index.where);

                    // build queries
                    const up = schema ? `ALTER INDEX "${schema}"."${index.name}" RENAME TO "${newIndexName}"` : `ALTER INDEX "${index.name}" RENAME TO "${newIndexName}"`;
                    const down = schema ? `ALTER INDEX "${schema}"."${newIndexName}" RENAME TO "${index.name}"` : `ALTER INDEX "${newIndexName}" RENAME TO "${index.name}"`;
                    upQueries.push(new Query(up));
                    downQueries.push(new Query(down));

                    // replace constraint name
                    index.name = newIndexName;
                });

                // rename foreign key constraints
                clonedTable.findColumnForeignKeys(oldColumn).forEach(foreignKey => {
                    // build new constraint name
                    foreignKey.columnNames.splice(foreignKey.columnNames.indexOf(oldColumn.name), 1);
                    foreignKey.columnNames.push(newColumn.name);
                    const newForeignKeyName = this.connection.namingStrategy.foreignKeyName(clonedTable, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);

                    // build queries
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${foreignKey.name}" TO "${newForeignKeyName}"`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${newForeignKeyName}" TO "${foreignKey.name}"`));

                    // replace constraint name
                    foreignKey.name = newForeignKeyName;
                });

                // rename old column in the Table object
                const oldTableColumn = clonedTable.columns.find(column => column.name === oldColumn.name);
                clonedTable.columns[clonedTable.columns.indexOf(oldTableColumn!)].name = newColumn.name;
                oldColumn.name = newColumn.name;
            }

            if (newColumn.precision !== oldColumn.precision || newColumn.scale !== oldColumn.scale) {
                upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" TYPE ${this.driver.createFullType(newColumn)}`));
                downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" TYPE ${this.driver.createFullType(oldColumn)}`));
            }

            if (
                (newColumn.type === "enum" || newColumn.type === "simple-enum")
                && (oldColumn.type === "enum" || oldColumn.type === "simple-enum")
                && (!OrmUtils.isArraysEqual(newColumn.enum!, oldColumn.enum!) || newColumn.enumName !== oldColumn.enumName)
            ) {
                const arraySuffix = newColumn.isArray ? "[]" : "";

                // "public"."new_enum"
                const newEnumName = this.buildEnumName(table, newColumn);

                // "public"."old_enum"
                const oldEnumName = this.buildEnumName(table, oldColumn);

                // "old_enum"
                const oldEnumNameWithoutSchema = this.buildEnumName(table, oldColumn, false);

                //"public"."old_enum_old"
                const oldEnumNameWithSchema_old = this.buildEnumName(table, oldColumn, true, false, true);

                //"old_enum_old"
                const oldEnumNameWithoutSchema_old = this.buildEnumName(table, oldColumn, false, false, true);

                // rename old ENUM
                upQueries.push(new Query(`ALTER TYPE ${oldEnumName} RENAME TO ${oldEnumNameWithoutSchema_old}`));
                downQueries.push(new Query(`ALTER TYPE ${oldEnumNameWithSchema_old} RENAME TO ${oldEnumNameWithoutSchema}`));

                // create new ENUM
                upQueries.push(this.createEnumTypeSql(table, newColumn, newEnumName));
                downQueries.push(this.dropEnumTypeSql(table, newColumn, newEnumName));

                // if column have default value, we must drop it to avoid issues with type casting
                if (oldColumn.default !== null && oldColumn.default !== undefined) {
                    // mark default as changed to prevent double update
                    defaultValueChanged = true
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" DROP DEFAULT`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" SET DEFAULT ${oldColumn.default}`));
                }

                // build column types
                const upType = `${newEnumName}${arraySuffix} USING "${newColumn.name}"::"text"::${newEnumName}${arraySuffix}`;
                const downType = `${oldEnumNameWithSchema_old}${arraySuffix} USING "${newColumn.name}"::"text"::${oldEnumNameWithSchema_old}${arraySuffix}`;

                // update column to use new type
                upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" TYPE ${upType}`));
                downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" TYPE ${downType}`));

                // restore column default or create new one
                if (newColumn.default !== null && newColumn.default !== undefined) {
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT ${newColumn.default}`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                }

                // remove old ENUM
                upQueries.push(this.dropEnumTypeSql(table, oldColumn, oldEnumNameWithSchema_old));
                downQueries.push(this.createEnumTypeSql(table, oldColumn, oldEnumNameWithSchema_old));
            }

            if (oldColumn.isNullable !== newColumn.isNullable) {
                if (newColumn.isNullable) {
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" DROP NOT NULL`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" SET NOT NULL`));
                } else {
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" SET NOT NULL`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" DROP NOT NULL`));
                }
            }

            if (oldColumn.comment !== newColumn.comment) {
                upQueries.push(new Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${oldColumn.name}" IS ${this.escapeComment(newColumn.comment)}`));
                downQueries.push(new Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${newColumn.name}" IS ${this.escapeComment(oldColumn.comment)}`));
            }

            if (newColumn.isPrimary !== oldColumn.isPrimary) {
                const primaryColumns = clonedTable.primaryColumns;

                // if primary column state changed, we must always drop existed constraint.
                if (primaryColumns.length > 0) {
                    const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map(column => column.name));
                    const columnNames = primaryColumns.map(column => `"${column.name}"`).join(", ");
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                }

                if (newColumn.isPrimary === true) {
                    primaryColumns.push(newColumn);
                    // update column in table
                    const column = clonedTable.columns.find(column => column.name === newColumn.name);
                    column!.isPrimary = true;
                    const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map(column => column.name));
                    const columnNames = primaryColumns.map(column => `"${column.name}"`).join(", ");
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));

                } else {
                    const primaryColumn = primaryColumns.find(c => c.name === newColumn.name);
                    primaryColumns.splice(primaryColumns.indexOf(primaryColumn!), 1);

                    // update column in table
                    const column = clonedTable.columns.find(column => column.name === newColumn.name);
                    column!.isPrimary = false;

                    // if we have another primary keys, we must recreate constraint.
                    if (primaryColumns.length > 0) {
                        const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map(column => column.name));
                        const columnNames = primaryColumns.map(column => `"${column.name}"`).join(", ");
                        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                    }
                }
            }

            if (newColumn.isUnique !== oldColumn.isUnique) {
                if (newColumn.isUnique === true) {
                    const uniqueConstraint = new TableUnique({
                        name: this.connection.namingStrategy.uniqueConstraintName(table, [newColumn.name]),
                        columnNames: [newColumn.name]
                    });
                    clonedTable.uniques.push(uniqueConstraint);
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE ("${newColumn.name}")`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueConstraint.name}"`));

                } else {
                    const uniqueConstraint = clonedTable.uniques.find(unique => {
                        return unique.columnNames.length === 1 && !!unique.columnNames.find(columnName => columnName === newColumn.name);
                    });
                    clonedTable.uniques.splice(clonedTable.uniques.indexOf(uniqueConstraint!), 1);
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueConstraint!.name}"`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint!.name}" UNIQUE ("${newColumn.name}")`));
                }
            }

            if (oldColumn.isGenerated !== newColumn.isGenerated) {
                // if old column was "generated", we should clear defaults
                if (oldColumn.isGenerated) {
                    if (oldColumn.generationStrategy === "uuid") {
                        // todo
                        // upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" DROP DEFAULT`));
                        // downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${oldColumn.name}" SET DEFAULT ${this.driver.uuidGenerator}`))

                    } else if (oldColumn.generationStrategy === "increment") {
                        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT nextval('${this.escapePath(this.buildSequencePath(table, newColumn))}')`));

                        upQueries.push(new Query(`DROP SEQUENCE ${this.escapePath(this.buildSequencePath(table, newColumn))}`));
                        downQueries.push(new Query(`CREATE SEQUENCE IF NOT EXISTS ${this.escapePath(this.buildSequencePath(table, newColumn))} OWNED BY ${this.escapePath(table)}."${newColumn.name}"`));
                    }
                }

                if (newColumn.generationStrategy === "uuid") {
                    // todo
                    // if (newColumn.isGenerated === true) {
                    //     upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT ${this.driver.uuidGenerator}`))
                    //     downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                    // } else {
                    //     upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                    //     downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT ${this.driver.uuidGenerator}`))
                    // }
                } else if (newColumn.generationStrategy === "increment") {
                    if (newColumn.isGenerated === true) {
                        upQueries.push(new Query(`CREATE SEQUENCE IF NOT EXISTS ${this.escapePath(this.buildSequencePath(table, newColumn))} OWNED BY ${this.escapePath(table)}."${newColumn.name}"`));
                        downQueries.push(new Query(`DROP SEQUENCE ${this.escapePath(this.buildSequencePath(table, newColumn))}`));

                        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT nextval('${this.escapePath(this.buildSequencePath(table, newColumn))}')`));
                        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));

                    } else {
                        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT nextval('${this.escapePath(this.buildSequencePath(table, newColumn))}')`));

                        upQueries.push(new Query(`DROP SEQUENCE ${this.escapePath(this.buildSequencePath(table, newColumn))}`));
                        downQueries.push(new Query(`CREATE SEQUENCE IF NOT EXISTS ${this.escapePath(this.buildSequencePath(table, newColumn))} OWNED BY ${this.escapePath(table)}."${newColumn.name}"`));
                    }
                }
            }

            // the default might have changed when the enum changed
            if (newColumn.default !== oldColumn.default && !defaultValueChanged) {
                if (newColumn.default !== null && newColumn.default !== undefined) {
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT ${newColumn.default}`));

                    if (oldColumn.default !== null && oldColumn.default !== undefined) {
                        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT ${oldColumn.default}`));
                    } else {
                        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                    }

                } else if (oldColumn.default !== null && oldColumn.default !== undefined) {
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" DROP DEFAULT`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" SET DEFAULT ${oldColumn.default}`));
                }
            }

            if ((newColumn.spatialFeatureType || "").toLowerCase() !== (oldColumn.spatialFeatureType || "").toLowerCase() || newColumn.srid !== oldColumn.srid) {
                upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" TYPE ${this.driver.createFullType(newColumn)}`));
                downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ALTER COLUMN "${newColumn.name}" TYPE ${this.driver.createFullType(oldColumn)}`));
            }

            if (newColumn.generatedType !== oldColumn.generatedType) {
                // Convert generated column data to normal column
                if (!newColumn.generatedType || newColumn.generatedType === "VIRTUAL") {
                    // We can copy the generated data to the new column
                    const tableNameWithSchema = (await this.getTableNameWithSchema(table.name)).split('.');
                    const tableName = tableNameWithSchema[1];
                    const schema = tableNameWithSchema[0];

                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} RENAME COLUMN "${oldColumn.name}" TO "TEMP_OLD_${oldColumn.name}"`));
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD ${this.buildCreateColumnSql(newColumn)}`));
                    upQueries.push(new Query(`UPDATE ${this.escapePath(table)} SET "${newColumn.name}" = "TEMP_OLD_${oldColumn.name}"`));
                    upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP COLUMN "TEMP_OLD_${oldColumn.name}"`));
                    upQueries.push(this.deleteTypeormMetadataSql({
                        database: this.driver.database,
                        schema,
                        table: tableName,
                        type: MetadataTableType.GENERATED_COLUMN,
                        name: oldColumn.name
                    }));
                    // However, we can't copy it back on downgrade. It needs to regenerate.
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP COLUMN "${newColumn.name}"`));
                    downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD ${this.buildCreateColumnSql(oldColumn)}`));
                    downQueries.push(this.deleteTypeormMetadataSql({
                        database: this.driver.database,
                        schema,
                        table: tableName,
                        type: MetadataTableType.GENERATED_COLUMN,
                        name: newColumn.name
                    }));
                    downQueries.push(this.insertTypeormMetadataSql({
                        database: this.driver.database,
                        schema,
                        table: tableName,
                        type: MetadataTableType.GENERATED_COLUMN,
                        name: oldColumn.name,
                        value: oldColumn.asExpression
                    }));
                }
            }

        }

        await this.executeQueries(upQueries, downQueries);
        this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Changes a column in the table.
     */
    async changeColumns(tableOrName: Table|string, changedColumns: { newColumn: TableColumn, oldColumn: TableColumn }[]): Promise<void> {
        for (const {oldColumn, newColumn} of changedColumns) {
            await this.changeColumn(tableOrName, oldColumn, newColumn);
        }
    }

    /**
     * Drops column in the table.
     */
    async dropColumn(tableOrName: Table|string, columnOrName: TableColumn|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const column = columnOrName instanceof TableColumn ? columnOrName : table.findColumnByName(columnOrName);
        if (!column)
            throw new TypeORMError(`Column "${columnOrName}" was not found in table "${table.name}"`);

        const clonedTable = table.clone();
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];

        // drop primary key constraint
        if (column.isPrimary) {
            const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, clonedTable.primaryColumns.map(column => column.name));
            const columnNames = clonedTable.primaryColumns.map(primaryColumn => `"${primaryColumn.name}"`).join(", ");
            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(clonedTable)} DROP CONSTRAINT "${pkName}"`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(clonedTable)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));

            // update column in table
            const tableColumn = clonedTable.findColumnByName(column.name);
            tableColumn!.isPrimary = false;

            // if primary key have multiple columns, we must recreate it without dropped column
            if (clonedTable.primaryColumns.length > 0) {
                const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, clonedTable.primaryColumns.map(column => column.name));
                const columnNames = clonedTable.primaryColumns.map(primaryColumn => `"${primaryColumn.name}"`).join(", ");
                upQueries.push(new Query(`ALTER TABLE ${this.escapePath(clonedTable)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                downQueries.push(new Query(`ALTER TABLE ${this.escapePath(clonedTable)} DROP CONSTRAINT "${pkName}"`));
            }
        }

        // drop column index
        const columnIndex = clonedTable.indices.find(index => index.columnNames.length === 1 && index.columnNames[0] === column.name);
        if (columnIndex) {
            clonedTable.indices.splice(clonedTable.indices.indexOf(columnIndex), 1);
            upQueries.push(this.dropIndexSql(table, columnIndex));
            downQueries.push(this.createIndexSql(table, columnIndex));
        }

        // drop column check
        const columnCheck = clonedTable.checks.find(check => !!check.columnNames && check.columnNames.length === 1 && check.columnNames[0] === column.name);
        if (columnCheck) {
            clonedTable.checks.splice(clonedTable.checks.indexOf(columnCheck), 1);
            upQueries.push(this.dropCheckConstraintSql(table, columnCheck));
            downQueries.push(this.createCheckConstraintSql(table, columnCheck));
        }

        // drop column unique
        const columnUnique = clonedTable.uniques.find(unique => unique.columnNames.length === 1 && unique.columnNames[0] === column.name);
        if (columnUnique) {
            clonedTable.uniques.splice(clonedTable.uniques.indexOf(columnUnique), 1);
            upQueries.push(this.dropUniqueConstraintSql(table, columnUnique));
            downQueries.push(this.createUniqueConstraintSql(table, columnUnique));
        }

        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP COLUMN "${column.name}"`));
        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD ${this.buildCreateColumnSql(column)}`));

        // drop enum type
        if (column.type === "enum" || column.type === "simple-enum") {
            const hasEnum = await this.hasEnumType(table, column);
            if (hasEnum) {
                const enumType = await this.getUserDefinedTypeName(table, column);
                const escapedEnumName = `"${enumType.schema}"."${enumType.name}"`;
                upQueries.push(this.dropEnumTypeSql(table, column, escapedEnumName));
                downQueries.push(this.createEnumTypeSql(table, column, escapedEnumName));
            }
        }

        if (column.generatedType === "STORED") {
            const tableNameWithSchema = (await this.getTableNameWithSchema(table.name)).split('.');
            const tableName = tableNameWithSchema[1];
            const schema = tableNameWithSchema[0];
            const insertQuery = this.deleteTypeormMetadataSql({
                database: this.driver.database,
                schema,
                table: tableName,
                type: MetadataTableType.GENERATED_COLUMN,
                name: column.name
            })
            const deleteQuery = this.insertTypeormMetadataSql({
                database: this.driver.database,
                schema,
                table: tableName,
                type: MetadataTableType.GENERATED_COLUMN,
                name: column.name,
                value: column.asExpression
            })

            upQueries.push(insertQuery);
            downQueries.push(deleteQuery);
        }

        await this.executeQueries(upQueries, downQueries);

        clonedTable.removeColumn(column);
        this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Drops the columns in the table.
     */
    async dropColumns(tableOrName: Table|string, columns: TableColumn[]|string[]): Promise<void> {
        for (const column of columns) {
            await this.dropColumn(tableOrName, column);
        }
    }

    /**
     * Creates a new primary key.
     *
     * Not supported in Spanner.
     * @see https://cloud.google.com/spanner/docs/schema-and-data-model#notes_about_key_columns
     */
    async createPrimaryKey(tableOrName: Table|string, columnNames: string[]): Promise<void> {
        throw new Error("The keys of a table can't change; you can't add a key column to an existing table or remove a key column from an existing table.")
    }

    /**
     * Updates composite primary keys.
     */
    async updatePrimaryKeys(tableOrName: Table|string, columns: TableColumn[]): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();
        const columnNames = columns.map(column => column.name);
        const upQueries: Query[] = [];
        const downQueries: Query[] = [];

        // if table already have primary columns, we must drop them.
        const primaryColumns = clonedTable.primaryColumns;
        if (primaryColumns.length > 0) {
            const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map(column => column.name));
            const columnNamesString = primaryColumns.map(column => `"${column.name}"`).join(", ");
            upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
            downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNamesString})`));
        }

        // update columns in table.
        clonedTable.columns
            .filter(column => columnNames.indexOf(column.name) !== -1)
            .forEach(column => column.isPrimary = true);

        const pkName = this.connection.namingStrategy.primaryKeyName(clonedTable, columnNames);
        const columnNamesString = columnNames.map(columnName => `"${columnName}"`).join(", ");
        upQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNamesString})`));
        downQueries.push(new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));

        await this.executeQueries(upQueries, downQueries);
        this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Creates a new primary key.
     *
     * Not supported in Spanner.
     * @see https://cloud.google.com/spanner/docs/schema-and-data-model#notes_about_key_columns
     */
    async dropPrimaryKey(tableOrName: Table|string): Promise<void> {
        throw new Error("The keys of a table can't change; you can't add a key column to an existing table or remove a key column from an existing table.")
    }

    /**
     * Creates new unique constraint.
     */
    async createUniqueConstraint(tableOrName: Table|string, uniqueConstraint: TableUnique): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new unique constraint may be passed without name. In this case we generate unique name manually.
        if (!uniqueConstraint.name)
            uniqueConstraint.name = this.connection.namingStrategy.uniqueConstraintName(table, uniqueConstraint.columnNames);

        const up = this.createUniqueConstraintSql(table, uniqueConstraint);
        const down = this.dropUniqueConstraintSql(table, uniqueConstraint);
        await this.executeQueries(up, down);
        table.addUniqueConstraint(uniqueConstraint);
    }

    /**
     * Creates new unique constraints.
     */
    async createUniqueConstraints(tableOrName: Table|string, uniqueConstraints: TableUnique[]): Promise<void> {
        for (const uniqueConstraint of uniqueConstraints) {
            await this.createUniqueConstraint(tableOrName, uniqueConstraint);
        }
    }

    /**
     * Drops unique constraint.
     */
    async dropUniqueConstraint(tableOrName: Table|string, uniqueOrName: TableUnique|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const uniqueConstraint = uniqueOrName instanceof TableUnique ? uniqueOrName : table.uniques.find(u => u.name === uniqueOrName);
        if (!uniqueConstraint)
            throw new TypeORMError(`Supplied unique constraint was not found in table ${table.name}`);

        const up = this.dropUniqueConstraintSql(table, uniqueConstraint);
        const down = this.createUniqueConstraintSql(table, uniqueConstraint);
        await this.executeQueries(up, down);
        table.removeUniqueConstraint(uniqueConstraint);
    }

    /**
     * Drops unique constraints.
     */
    async dropUniqueConstraints(tableOrName: Table|string, uniqueConstraints: TableUnique[]): Promise<void> {
        for (const uniqueConstraint of uniqueConstraints) {
            await this.dropUniqueConstraint(tableOrName, uniqueConstraint);
        }
    }

    /**
     * Creates new check constraint.
     */
    async createCheckConstraint(tableOrName: Table|string, checkConstraint: TableCheck): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new unique constraint may be passed without name. In this case we generate unique name manually.
        if (!checkConstraint.name)
            checkConstraint.name = this.connection.namingStrategy.checkConstraintName(table, checkConstraint.expression!);

        const up = this.createCheckConstraintSql(table, checkConstraint);
        const down = this.dropCheckConstraintSql(table, checkConstraint);
        await this.executeQueries(up, down);
        table.addCheckConstraint(checkConstraint);
    }

    /**
     * Creates new check constraints.
     */
    async createCheckConstraints(tableOrName: Table|string, checkConstraints: TableCheck[]): Promise<void> {
        const promises = checkConstraints.map(checkConstraint => this.createCheckConstraint(tableOrName, checkConstraint));
        await Promise.all(promises);
    }

    /**
     * Drops check constraint.
     */
    async dropCheckConstraint(tableOrName: Table|string, checkOrName: TableCheck|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const checkConstraint = checkOrName instanceof TableCheck ? checkOrName : table.checks.find(c => c.name === checkOrName);
        if (!checkConstraint)
            throw new TypeORMError(`Supplied check constraint was not found in table ${table.name}`);

        const up = this.dropCheckConstraintSql(table, checkConstraint);
        const down = this.createCheckConstraintSql(table, checkConstraint);
        await this.executeQueries(up, down);
        table.removeCheckConstraint(checkConstraint);
    }

    /**
     * Drops check constraints.
     */
    async dropCheckConstraints(tableOrName: Table|string, checkConstraints: TableCheck[]): Promise<void> {
        const promises = checkConstraints.map(checkConstraint => this.dropCheckConstraint(tableOrName, checkConstraint));
        await Promise.all(promises);
    }

    /**
     * Creates new exclusion constraint.
     */
    async createExclusionConstraint(tableOrName: Table|string, exclusionConstraint: TableExclusion): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new unique constraint may be passed without name. In this case we generate unique name manually.
        if (!exclusionConstraint.name)
            exclusionConstraint.name = this.connection.namingStrategy.exclusionConstraintName(table, exclusionConstraint.expression!);

        const up = this.createExclusionConstraintSql(table, exclusionConstraint);
        const down = this.dropExclusionConstraintSql(table, exclusionConstraint);
        await this.executeQueries(up, down);
        table.addExclusionConstraint(exclusionConstraint);
    }

    /**
     * Creates new exclusion constraints.
     */
    async createExclusionConstraints(tableOrName: Table|string, exclusionConstraints: TableExclusion[]): Promise<void> {
        const promises = exclusionConstraints.map(exclusionConstraint => this.createExclusionConstraint(tableOrName, exclusionConstraint));
        await Promise.all(promises);
    }

    /**
     * Drops exclusion constraint.
     */
    async dropExclusionConstraint(tableOrName: Table|string, exclusionOrName: TableExclusion|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const exclusionConstraint = exclusionOrName instanceof TableExclusion ? exclusionOrName : table.exclusions.find(c => c.name === exclusionOrName);
        if (!exclusionConstraint)
            throw new TypeORMError(`Supplied exclusion constraint was not found in table ${table.name}`);

        const up = this.dropExclusionConstraintSql(table, exclusionConstraint);
        const down = this.createExclusionConstraintSql(table, exclusionConstraint);
        await this.executeQueries(up, down);
        table.removeExclusionConstraint(exclusionConstraint);
    }

    /**
     * Drops exclusion constraints.
     */
    async dropExclusionConstraints(tableOrName: Table|string, exclusionConstraints: TableExclusion[]): Promise<void> {
        const promises = exclusionConstraints.map(exclusionConstraint => this.dropExclusionConstraint(tableOrName, exclusionConstraint));
        await Promise.all(promises);
    }

    /**
     * Creates a new foreign key.
     */
    async createForeignKey(tableOrName: Table|string, foreignKey: TableForeignKey): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new FK may be passed without name. In this case we generate FK name manually.
        if (!foreignKey.name)
            foreignKey.name = this.connection.namingStrategy.foreignKeyName(table, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);

        const up = this.createForeignKeySql(table, foreignKey);
        const down = this.dropForeignKeySql(table, foreignKey);
        await this.executeQueries(up, down);
        table.addForeignKey(foreignKey);
    }

    /**
     * Creates a new foreign keys.
     */
    async createForeignKeys(tableOrName: Table|string, foreignKeys: TableForeignKey[]): Promise<void> {
        for (const foreignKey of foreignKeys) {
            await this.createForeignKey(tableOrName, foreignKey);
        }
    }

    /**
     * Drops a foreign key from the table.
     */
    async dropForeignKey(tableOrName: Table|string, foreignKeyOrName: TableForeignKey|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const foreignKey = foreignKeyOrName instanceof TableForeignKey ? foreignKeyOrName : table.foreignKeys.find(fk => fk.name === foreignKeyOrName);
        if (!foreignKey)
            throw new TypeORMError(`Supplied foreign key was not found in table ${table.name}`);

        const up = this.dropForeignKeySql(table, foreignKey);
        const down = this.createForeignKeySql(table, foreignKey);
        await this.executeQueries(up, down);
        table.removeForeignKey(foreignKey);
    }

    /**
     * Drops a foreign keys from the table.
     */
    async dropForeignKeys(tableOrName: Table|string, foreignKeys: TableForeignKey[]): Promise<void> {
        for (const foreignKey of foreignKeys) {
            await this.dropForeignKey(tableOrName, foreignKey);
        }
    }

    /**
     * Creates a new index.
     */
    async createIndex(tableOrName: Table|string, index: TableIndex): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new index may be passed without name. In this case we generate index name manually.
        if (!index.name)
            index.name = this.connection.namingStrategy.indexName(table, index.columnNames, index.where);

        const up = this.createIndexSql(table, index);
        const down = this.dropIndexSql(table, index);
        await this.executeQueries(up, down);
        table.addIndex(index);
    }

    /**
     * Creates a new indices
     */
    async createIndices(tableOrName: Table|string, indices: TableIndex[]): Promise<void> {
        for (const index of indices) {
            await this.createIndex(tableOrName, index);
        }
    }

    /**
     * Drops an index from the table.
     */
    async dropIndex(tableOrName: Table|string, indexOrName: TableIndex|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const index = indexOrName instanceof TableIndex ? indexOrName : table.indices.find(i => i.name === indexOrName);
        if (!index)
            throw new TypeORMError(`Supplied index ${indexOrName} was not found in table ${table.name}`);

        const up = this.dropIndexSql(table, index);
        const down = this.createIndexSql(table, index);
        await this.executeQueries(up, down);
        table.removeIndex(index);
    }

    /**
     * Drops an indices from the table.
     */
    async dropIndices(tableOrName: Table|string, indices: TableIndex[]): Promise<void> {
        for (const index of indices) {
            await this.dropIndex(tableOrName, index);
        }
    }

    /**
     * Clears all table contents.
     * Note: this operation uses SQL's TRUNCATE query which cannot be reverted in transactions.
     */
    async clearTable(tableName: string): Promise<void> {
        await this.query(`TRUNCATE TABLE ${this.escapePath(tableName)}`);
    }

    /**
     * Removes all tables from the currently connected database.
     */
    async clearDatabase(): Promise<void> {

        await this.startTransaction();
        try {
            // drop views
            // const selectViewDropsQuery = `SELECT concat('DROP VIEW \`', TABLE_NAME, '\`') AS \`query\` FROM \`INFORMATION_SCHEMA\`.\`VIEWS\``;
            // const dropViewQueries: ObjectLiteral[] = await this.query(selectViewDropsQuery);
            // await Promise.all(dropViewQueries.map(q => this.updateDDL(q["query"])));

            // drop indices
            const selectIndexDropsQuery = `SELECT concat('DROP INDEX \`', INDEX_NAME, '\`') AS \`query\` ` +
                `FROM \`INFORMATION_SCHEMA\`.\`INDEXES\` ` +
                `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' AND \`INDEX_TYPE\` = 'INDEX'`;
            const dropIndexQueries: ObjectLiteral[] = await this.query(selectIndexDropsQuery);
            await Promise.all(dropIndexQueries.map(q => this.updateDDL(q["query"])));

            // drop tables
            const dropTablesQuery = `SELECT concat('DROP TABLE \`', TABLE_NAME, '\`') AS \`query\` ` +
                `FROM \`INFORMATION_SCHEMA\`.\`TABLES\` ` +
                `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = ''`;
            const dropQueries: ObjectLiteral[] = await this.query(dropTablesQuery);
            await Promise.all(dropQueries.map(query => this.updateDDL(query["query"])));

            await this.commitTransaction();

        } catch (error) {
            try { // we throw original error even if rollback thrown an error
                await this.rollbackTransaction();
            } catch (rollbackError) { }
            throw error;
        }
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    protected async loadViews(viewNames?: string[]): Promise<View[]> {
        const hasTable = await this.hasTable(this.getTypeormMetadataTableName());

        if (!hasTable)
            return [];

        if (!viewNames) {
            viewNames = [];
        }

        const viewsCondition = viewNames.length === 0 ? "1=1" : viewNames
            .map(tableName => this.driver.parseTableName(tableName))
            .map(({ schema, tableName }) => {
                return `("t"."name" = '${tableName}')`;
            }).join(" OR ");

        const query = `SELECT "t".* FROM ${this.escapePath(this.getTypeormMetadataTableName())} "t" ` +
            `INNER JOIN "pg_catalog"."pg_class" "c" ON "c"."relname" = "t"."name" ` +
            `INNER JOIN "pg_namespace" "n" ON "n"."oid" = "c"."relnamespace" AND "n"."nspname" = "t"."schema" ` +
            `WHERE "t"."type" IN ('${MetadataTableType.VIEW}', '${MetadataTableType.MATERIALIZED_VIEW}') ${viewsCondition ? `AND (${viewsCondition})` : ""}`;

        const dbViews = await this.query(query);
        return dbViews.map((dbView: any) => {
            const view = new View();
            view.schema = dbView["schema"];
            view.name = this.driver.buildTableName(dbView["name"]);
            view.expression = dbView["value"];
            view.materialized = dbView["type"] === MetadataTableType.MATERIALIZED_VIEW;
            return view;
        });
    }

    /**
     * Loads all tables (with given names) from the database and creates a Table from them.
     */
    protected async loadTables(tableNames?: string[]): Promise<Table[]> {
        if (tableNames && tableNames.length === 0) {
            return [];
        }

        const dbTables: { TABLE_NAME: string }[] = [];

        if (!tableNames || !tableNames.length) {
            // Since we don't have any of this data we have to do a scan
            const tablesSql = `SELECT \`TABLE_NAME\` FROM \`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = ''`;
            dbTables.push(...await this.query(tablesSql));
        } else {
            const tablesSql = `SELECT \`TABLE_NAME\` ` +
                `FROM \`INFORMATION_SCHEMA\`.\`TABLES\` ` +
                `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' ` +
                `AND \`TABLE_NAME\` IN (${tableNames.map(tableName => `'${tableName}'`).join(", ")})`;

            dbTables.push(...await this.query(tablesSql));
        }


        // if tables were not found in the db, no need to proceed
        if (!dbTables.length)
            return [];

        const loadedTableNames = dbTables.map(dbTable => `'${dbTable.TABLE_NAME}'`).join(", ")

        const kcuSubquerySql = `SELECT * FROM \`INFORMATION_SCHEMA\`.\`KEY_COLUMN_USAGE\` ` +
            `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' ` +
            `AND \`TABLE_NAME\` IN (${loadedTableNames})`;

        const columnsSql = `SELECT * FROM \`INFORMATION_SCHEMA\`.\`COLUMNS\` ` +
            `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' ` +
            `AND \`TABLE_NAME\` IN (${loadedTableNames})`;

        // Key Column Usage but only for PKs
        const primaryKeySql = `SELECT * FROM (${kcuSubquerySql}) \`kcu\` WHERE \`CONSTRAINT_NAME\` = 'PRIMARY'`;

        // Combine stats & referential constraints
        const indicesSql = `SELECT * FROM \`INFORMATION_SCHEMA\`.\`INDEXES\` ` +
            `WHERE \`TABLE_CATALOG\` = '' AND \`TABLE_SCHEMA\` = '' ` +
            `AND \`TABLE_NAME\` IN (${loadedTableNames})`;

        // Combine Key Column Usage & Referential Constraints
        const foreignKeysSql = `SELECT \`TC\`.\`TABLE_NAME\`, \`TC\`.\`CONSTRAINT_NAME\`, \`KCU\`.\`COLUMN_NAME\`, ` +
            `\`CTU\`.\`TABLE_NAME\` AS \`REFERENCED_TABLE_NAME\`, \`CCU\`.\`COLUMN_NAME\` AS \`REFERENCED_COLUMN_NAME\`, ` +
            `\`RC\`.\`UPDATE_RULE\`, \`RC\`.\`DELETE_RULE\` ` +
            `FROM \`INFORMATION_SCHEMA\`.\`TABLE_CONSTRAINTS\` \`TC\` ` +
            `INNER JOIN \`INFORMATION_SCHEMA\`.\`KEY_COLUMN_USAGE\` \`KCU\` ON \`KCU\`.\`CONSTRAINT_NAME\` = \`TC\`.\`CONSTRAINT_NAME\` ` +
            `INNER JOIN \`INFORMATION_SCHEMA\`.\`CONSTRAINT_TABLE_USAGE\` \`CTU\` ON \`CTU\`.\`CONSTRAINT_NAME\` = \`TC\`.\`CONSTRAINT_NAME\` ` +
            `INNER JOIN \`INFORMATION_SCHEMA\`.\`REFERENTIAL_CONSTRAINTS\` \`RC\` ON \`RC\`.\`CONSTRAINT_NAME\` = \`TC\`.\`CONSTRAINT_NAME\` ` +
            `INNER JOIN \`INFORMATION_SCHEMA\`.\`CONSTRAINT_COLUMN_USAGE\` \`CCU\` ON \`CCU\`.\`CONSTRAINT_NAME\` = \`TC\`.\`CONSTRAINT_NAME\` ` +
            `WHERE \`TC\`.\`TABLE_CATALOG\` = '' AND \`TC\`.\`TABLE_SCHEMA\` = '' AND \`TC\`.\`CONSTRAINT_TYPE\` = 'FOREIGN KEY' ` +
            `AND \`TC\`.\`TABLE_NAME\` IN (${loadedTableNames})`;

        const [dbColumns, dbPrimaryKeys, dbIndices, dbForeignKeys]: ObjectLiteral[][] = await Promise.all([
            this.query(columnsSql),
            this.query(primaryKeySql),
            this.query(indicesSql),
            this.query(foreignKeysSql)
        ]);

        // create tables for loaded tables
        return Promise.all(dbTables.map(async dbTable => {
            const table = new Table();

            table.name = this.driver.buildTableName(dbTable["TABLE_NAME"]);

            // create columns from the loaded columns
            table.columns = dbColumns
                .filter(dbColumn => dbColumn["TABLE_NAME"] === dbTable["TABLE_NAME"])
                .map(dbColumn => {

                    const columnUniqueIndices = dbIndices.filter(dbIndex => {
                        return dbIndex["TABLE_NAME"] === dbTable["TABLE_NAME"]
                            && dbIndex["COLUMN_NAME"] === dbColumn["COLUMN_NAME"]
                            && parseInt(dbIndex["NON_UNIQUE"], 10) === 0
                    })

                    const tableMetadata = this.connection.entityMetadatas.find(metadata => this.getTablePath(table) === this.getTablePath(metadata));
                    const hasIgnoredIndex = columnUniqueIndices.length > 0
                        && tableMetadata
                        && tableMetadata.indices.some(index => {
                            return columnUniqueIndices.some(uniqueIndex => {
                                return index.name === uniqueIndex["INDEX_NAME"] && index.synchronize === false;
                            });
                        });

                    const isConstraintComposite = columnUniqueIndices.every((uniqueIndex) => {
                        return dbIndices.some(dbIndex => dbIndex["INDEX_NAME"] === uniqueIndex["INDEX_NAME"] && dbIndex["COLUMN_NAME"] !== dbColumn["COLUMN_NAME"]);
                    })

                    const tableColumn = new TableColumn();
                    tableColumn.name = dbColumn["COLUMN_NAME"];
                    tableColumn.type = dbColumn["SPANNER_TYPE"].toLowerCase();

                    if (this.driver.withWidthColumnTypes.indexOf(tableColumn.type as ColumnType) !== -1) {
                        const width = tableColumn.type.substring(tableColumn.type.indexOf("(") + 1, tableColumn.type.indexOf(")"));
                        if (width !== "MAX")
                            tableColumn.width = parseInt(width) // && !this.isDefaultColumnWidth(table, tableColumn, parseInt(width)) ? parseInt(width) : undefined;

                        tableColumn.type = tableColumn.type.substring(0, tableColumn.type.indexOf("("));
                    }

                    console.log(tableColumn.type);

                    if (dbColumn["COLUMN_DEFAULT"] === null || dbColumn["COLUMN_DEFAULT"] === undefined) {
                        tableColumn.default = undefined;

                    } else if (/^CURRENT_TIMESTAMP(\([0-9]*\))?$/i.test(dbColumn["COLUMN_DEFAULT"])) {
                        // New versions of MariaDB return expressions in lowercase.  We need to set it in
                        // uppercase so the comparison in MysqlDriver#compareDefaultValues does not fail.
                        tableColumn.default = dbColumn["COLUMN_DEFAULT"].toUpperCase();
                    } else {
                        tableColumn.default = `'${dbColumn["COLUMN_DEFAULT"]}'`;
                    }

                    if (dbColumn["GENERATION_EXPRESSION"]) {
                        tableColumn.asExpression = dbColumn["GENERATION_EXPRESSION"];
                        tableColumn.generatedType = dbColumn["EXTRA"].indexOf("VIRTUAL") !== -1 ? "VIRTUAL" : "STORED";
                    }

                    tableColumn.isUnique = columnUniqueIndices.length > 0 && !hasIgnoredIndex && !isConstraintComposite;
                    tableColumn.isNullable = dbColumn["IS_NULLABLE"] === "YES";
                    tableColumn.isPrimary = dbPrimaryKeys.some(dbPrimaryKey => {
                        return (
                            dbPrimaryKey["TABLE_NAME"] === dbColumn["TABLE_NAME"] &&
                            dbPrimaryKey["TABLE_SCHEMA"] === dbColumn["TABLE_SCHEMA"] &&
                            dbPrimaryKey["COLUMN_NAME"] === dbColumn["COLUMN_NAME"]
                        );
                    });

                    // if (tableColumn.isGenerated)
                    //     tableColumn.generationStrategy = "increment";

                    tableColumn.comment = (typeof dbColumn["COLUMN_COMMENT"] === "string" && dbColumn["COLUMN_COMMENT"].length === 0) ? undefined : dbColumn["COLUMN_COMMENT"];

                    // check only columns that have length property
                    if (this.driver.withLengthColumnTypes.indexOf(tableColumn.type as ColumnType) !== -1 && dbColumn["CHARACTER_MAXIMUM_LENGTH"]) {
                        const length = dbColumn["CHARACTER_MAXIMUM_LENGTH"].toString();
                        tableColumn.length = !this.isDefaultColumnLength(table, tableColumn, length) ? length : "";
                    }

                    if (tableColumn.type === "decimal" || tableColumn.type === "double" || tableColumn.type === "float") {
                        if (dbColumn["NUMERIC_PRECISION"] !== null && !this.isDefaultColumnPrecision(table, tableColumn, dbColumn["NUMERIC_PRECISION"]))
                            tableColumn.precision = parseInt(dbColumn["NUMERIC_PRECISION"]);
                        if (dbColumn["NUMERIC_SCALE"] !== null && !this.isDefaultColumnScale(table, tableColumn, dbColumn["NUMERIC_SCALE"]))
                            tableColumn.scale = parseInt(dbColumn["NUMERIC_SCALE"]);
                    }

                    if (tableColumn.type === "enum" || tableColumn.type === "simple-enum" || tableColumn.type === "set") {
                        const colType = dbColumn["COLUMN_TYPE"];
                        const items = colType.substring(colType.indexOf("(") + 1, colType.lastIndexOf(")")).split(",");
                        tableColumn.enum = (items as string[]).map(item => {
                            return item.substring(1, item.length - 1);
                        });
                        tableColumn.length = "";
                    }

                    if ((tableColumn.type === "datetime" || tableColumn.type === "time" || tableColumn.type === "timestamp")
                        && dbColumn["DATETIME_PRECISION"] !== null && dbColumn["DATETIME_PRECISION"] !== undefined
                        && !this.isDefaultColumnPrecision(table, tableColumn, parseInt(dbColumn["DATETIME_PRECISION"]))) {
                        tableColumn.precision = parseInt(dbColumn["DATETIME_PRECISION"]);
                    }

                    return tableColumn;
                });

            // find foreign key constraints of table, group them by constraint name and build TableForeignKey.
            const tableForeignKeyConstraints = OrmUtils.uniq(dbForeignKeys.filter(dbForeignKey => {
                return dbForeignKey["TABLE_NAME"] === dbTable["TABLE_NAME"];
            }), dbForeignKey => dbForeignKey["CONSTRAINT_NAME"]);

            table.foreignKeys = tableForeignKeyConstraints.map(dbForeignKey => {
                const foreignKeys = dbForeignKeys.filter(dbFk => dbFk["CONSTRAINT_NAME"] === dbForeignKey["CONSTRAINT_NAME"]);

                return new TableForeignKey({
                    name: dbForeignKey["CONSTRAINT_NAME"],
                    columnNames: foreignKeys.map(dbFk => dbFk["COLUMN_NAME"]),
                    referencedDatabase: dbForeignKey["REFERENCED_TABLE_SCHEMA"],
                    referencedTableName: dbForeignKey["REFERENCED_TABLE_NAME"],
                    referencedColumnNames: foreignKeys.map(dbFk => dbFk["REFERENCED_COLUMN_NAME"]),
                    onDelete: dbForeignKey["DELETE_RULE"],
                    onUpdate: dbForeignKey["UPDATE_RULE"]
                });
            });

            // find index constraints of table, group them by constraint name and build TableIndex.
            const tableIndexConstraints = OrmUtils.uniq(dbIndices.filter(dbIndex => (
                dbIndex["TABLE_NAME"] === dbTable["TABLE_NAME"]
            )), dbIndex => dbIndex["INDEX_NAME"]);

            table.indices = tableIndexConstraints.map(constraint => {
                const indices = dbIndices.filter(index => {
                    return index["TABLE_SCHEMA"] === constraint["TABLE_SCHEMA"]
                        && index["TABLE_NAME"] === constraint["TABLE_NAME"]
                        && index["INDEX_NAME"] === constraint["INDEX_NAME"];
                });

                const nonUnique = parseInt(constraint["NON_UNIQUE"], 10);

                return new TableIndex(<TableIndexOptions>{
                    table: table,
                    name: constraint["INDEX_NAME"],
                    columnNames: indices.map(i => i["COLUMN_NAME"]),
                    isUnique: nonUnique === 0,
                    isSpatial: constraint["INDEX_TYPE"] === "SPATIAL",
                    isFulltext: constraint["INDEX_TYPE"] === "FULLTEXT"
                });
            });

            return table;
        }));
    }

    /**
     * Builds create table sql.
     */
    protected createTableSql(table: Table, createForeignKeys?: boolean): Query {
        const columnDefinitions = table.columns.map(column => this.buildCreateColumnSql(column)).join(", ");
        let sql = `CREATE TABLE ${this.escapePath(table)} (${columnDefinitions}`;

        table.columns
            .filter(column => column.isUnique)
            .forEach(column => {
                const isUniqueExist = table.uniques.some(unique => unique.columnNames.length === 1 && unique.columnNames[0] === column.name);
                if (!isUniqueExist)
                    table.uniques.push(new TableUnique({
                        name: this.connection.namingStrategy.uniqueConstraintName(table, [column.name]),
                        columnNames: [column.name]
                    }));
            });

        // if (table.uniques.length > 0) {
        //     const uniquesSql = table.uniques.map(unique => {
        //         const uniqueName = unique.name ? unique.name : this.connection.namingStrategy.uniqueConstraintName(table, unique.columnNames);
        //         const columnNames = unique.columnNames.map(columnName => `"${columnName}"`).join(", ");
        //         let constraint = `CONSTRAINT "${uniqueName}" UNIQUE (${columnNames})`;
        //         if (unique.deferrable)
        //             constraint += ` DEFERRABLE ${unique.deferrable}`;
        //         return constraint;
        //     }).join(", ");
        //
        //     sql += `, ${uniquesSql}`;
        // }
        //
        // if (table.checks.length > 0) {
        //     const checksSql = table.checks.map(check => {
        //         const checkName = check.name ? check.name : this.connection.namingStrategy.checkConstraintName(table, check.expression!);
        //         return `CONSTRAINT "${checkName}" CHECK (${check.expression})`;
        //     }).join(", ");
        //
        //     sql += `, ${checksSql}`;
        // }
        //
        // if (table.exclusions.length > 0) {
        //     const exclusionsSql = table.exclusions.map(exclusion => {
        //         const exclusionName = exclusion.name ? exclusion.name : this.connection.namingStrategy.exclusionConstraintName(table, exclusion.expression!);
        //         return `CONSTRAINT "${exclusionName}" EXCLUDE ${exclusion.expression}`;
        //     }).join(", ");
        //
        //     sql += `, ${exclusionsSql}`;
        // }

        if (table.foreignKeys.length > 0 && createForeignKeys) {
            const foreignKeysSql = table.foreignKeys.map(fk => {
                const columnNames = fk.columnNames.map(columnName => `\`${columnName}\``).join(", ");
                if (!fk.name)
                    fk.name = this.connection.namingStrategy.foreignKeyName(table, fk.columnNames, this.getTablePath(fk), fk.referencedColumnNames);
                const referencedColumnNames = fk.referencedColumnNames.map(columnName => `\`${columnName}\``).join(", ");

                let constraint = `CONSTRAINT \`${fk.name}\` FOREIGN KEY (${columnNames}) REFERENCES ${this.escapePath(this.getTablePath(fk))} (${referencedColumnNames})`;
                if (fk.onDelete)
                    constraint += ` ON DELETE ${fk.onDelete}`;
                if (fk.onUpdate)
                    constraint += ` ON UPDATE ${fk.onUpdate}`;

                return constraint;
            }).join(", ");

            sql += `, ${foreignKeysSql}`;
        }

        sql += `)`;

        const primaryColumns = table.columns.filter(column => column.isPrimary);
        if (primaryColumns.length > 0) {
            const columnNames = primaryColumns.map(column => this.driver.escape(column.name)).join(", ");
            sql += ` PRIMARY KEY (${columnNames})`;
        }

        table.columns
            .filter(it => it.comment)
            .forEach(it => sql += `; COMMENT ON COLUMN ${this.escapePath(table)}."${it.name}" IS ${this.escapeComment(it.comment)}`);

        return new Query(sql);
    }

    /**
     * Loads Spanner version.
     */
    protected async getVersion(): Promise<string> {
        const result = await this.query(`SHOW SERVER_VERSION`);
        return result[0]["server_version"];
    }

    /**
     * Builds drop table sql.
     */
    protected dropTableSql(tableOrPath: Table|string): Query {
        return new Query(`DROP TABLE ${this.escapePath(tableOrPath)}`);
    }

    protected createViewSql(view: View): Query {
        const materializedClause = view.materialized ? "MATERIALIZED " : "";
        const viewName = this.escapePath(view);

        if (typeof view.expression === "string") {
            return new Query(`CREATE ${materializedClause}VIEW ${viewName} AS ${view.expression}`);
        } else {
            return new Query(`CREATE ${materializedClause}VIEW ${viewName} AS ${view.expression(this.connection).getQuery()}`);
        }
    }

    protected async insertViewDefinitionSql(view: View): Promise<Query> {
        const currentSchema = await this.getCurrentSchema()

        let { schema, tableName: name } = this.driver.parseTableName(view);

        if (!schema) {
            schema = currentSchema;
        }

        const type = view.materialized ? MetadataTableType.MATERIALIZED_VIEW : MetadataTableType.VIEW
        const expression = typeof view.expression === "string" ? view.expression.trim() : view.expression(this.connection).getQuery();
        return this.insertTypeormMetadataSql({ type, schema, name, value: expression })
    }

    /**
     * Builds drop view sql.
     */
    protected dropViewSql(view: View): Query {
        const materializedClause = view.materialized ? "MATERIALIZED " : "";
        return new Query(`DROP ${materializedClause}VIEW ${this.escapePath(view)}`);
    }

    /**
     * Builds remove view sql.
     */
    protected async deleteViewDefinitionSql(view: View): Promise<Query> {
        const currentSchema = await this.getCurrentSchema()

        let { schema, tableName: name } = this.driver.parseTableName(view);

        if (!schema) {
            schema = currentSchema;
        }

        const type = view.materialized ? MetadataTableType.MATERIALIZED_VIEW : MetadataTableType.VIEW
        return this.deleteTypeormMetadataSql({ type, schema, name })
    }

    /**
     * Drops ENUM type from given schemas.
     */
    protected async dropEnumTypes(schemaNames: string): Promise<void> {
        const selectDropsQuery = `SELECT 'DROP TYPE IF EXISTS "' || n.nspname || '"."' || t.typname || '" CASCADE;' as "query" FROM "pg_type" "t" ` +
            `INNER JOIN "pg_enum" "e" ON "e"."enumtypid" = "t"."oid" ` +
            `INNER JOIN "pg_namespace" "n" ON "n"."oid" = "t"."typnamespace" ` +
            `WHERE "n"."nspname" IN (${schemaNames}) GROUP BY "n"."nspname", "t"."typname"`;
        const dropQueries: ObjectLiteral[] = await this.query(selectDropsQuery);
        await Promise.all(dropQueries.map(q => this.query(q["query"])));
    }

    /**
     * Checks if enum with the given name exist in the database.
     */
    protected async hasEnumType(table: Table, column: TableColumn): Promise<boolean> {
        let { schema } = this.driver.parseTableName(table);

        if (!schema) {
            schema = await this.getCurrentSchema();
        }

        const enumName = this.buildEnumName(table, column, false, true);
        const sql = `SELECT "n"."nspname", "t"."typname" FROM "pg_type" "t" ` +
            `INNER JOIN "pg_namespace" "n" ON "n"."oid" = "t"."typnamespace" ` +
            `WHERE "n"."nspname" = '${schema}' AND "t"."typname" = '${enumName}'`;
        const result = await this.query(sql);
        return result.length ? true : false;
    }

    /**
     * Builds create ENUM type sql.
     */
    protected createEnumTypeSql(table: Table, column: TableColumn, enumName?: string): Query {
        if (!enumName) enumName = this.buildEnumName(table, column);
        const enumValues = column.enum!.map(value => `'${value.replace("'", "''")}'`).join(", ");
        return new Query(`CREATE TYPE ${enumName} AS ENUM(${enumValues})`);
    }

    /**
     * Builds create ENUM type sql.
     */
    protected dropEnumTypeSql(table: Table, column: TableColumn, enumName?: string): Query {
        if (!enumName) enumName = this.buildEnumName(table, column);
        return new Query(`DROP TYPE ${enumName}`);
    }

    /**
     * Builds create index sql.
     */
    protected createIndexSql(table: Table, index: TableIndex): Query {
        const columns = index.columnNames.map(columnName => this.driver.escape(columnName)).join(", ");
        let indexType = "";
        if (index.isUnique)
            indexType += "UNIQUE ";
        if (index.isNullFiltered)
            indexType += "NULL_FILTERED ";

        return new Query(`CREATE ${indexType}INDEX \`${index.name}\` ON ${this.escapePath(table)} (${columns})`);
    }

    /**
     * Builds drop index sql.
     */
    protected dropIndexSql(table: Table, indexOrName: TableIndex|string): Query {
        let indexName = indexOrName instanceof TableIndex ? indexOrName.name : indexOrName;
        return new Query(`DROP INDEX \`${indexName}\` ON ${this.escapePath(table)}`);
    }

    /**
     * Builds create unique constraint sql.
     */
    protected createUniqueConstraintSql(table: Table, uniqueConstraint: TableUnique): Query {
        const columnNames = uniqueConstraint.columnNames.map(column => `"` + column + `"`).join(", ");
        let sql = `ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE (${columnNames})`;
        if (uniqueConstraint.deferrable)
            sql += ` DEFERRABLE ${uniqueConstraint.deferrable}`;
        return new Query(sql);
    }

    /**
     * Builds drop unique constraint sql.
     */
    protected dropUniqueConstraintSql(table: Table, uniqueOrName: TableUnique|string): Query {
        const uniqueName = uniqueOrName instanceof TableUnique ? uniqueOrName.name : uniqueOrName;
        return new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueName}"`);
    }

    /**
     * Builds create check constraint sql.
     */
    protected createCheckConstraintSql(table: Table, checkConstraint: TableCheck): Query {
        return new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${checkConstraint.name}" CHECK (${checkConstraint.expression})`);
    }

    /**
     * Builds drop check constraint sql.
     */
    protected dropCheckConstraintSql(table: Table, checkOrName: TableCheck|string): Query {
        const checkName = checkOrName instanceof TableCheck ? checkOrName.name : checkOrName;
        return new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${checkName}"`);
    }

    /**
     * Builds create exclusion constraint sql.
     */
    protected createExclusionConstraintSql(table: Table, exclusionConstraint: TableExclusion): Query {
        return new Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${exclusionConstraint.name}" EXCLUDE ${exclusionConstraint.expression}`);
    }

    /**
     * Builds drop exclusion constraint sql.
     */
    protected dropExclusionConstraintSql(table: Table, exclusionOrName: TableExclusion|string): Query {
        const exclusionName = exclusionOrName instanceof TableExclusion ? exclusionOrName.name : exclusionOrName;
        return new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${exclusionName}"`);
    }

    /**
     * Builds create foreign key sql.
     */
    protected createForeignKeySql(table: Table, foreignKey: TableForeignKey): Query {
        const columnNames = foreignKey.columnNames.map(column => this.driver.escape(column)).join(", ");
        const referencedColumnNames = foreignKey.referencedColumnNames.map(column => this.driver.escape(column)).join(",");
        let sql = `ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT \`${foreignKey.name}\` FOREIGN KEY (${columnNames}) ` +
            `REFERENCES ${this.escapePath(this.getTablePath(foreignKey))} (${referencedColumnNames})`;

        return new Query(sql);
    }

    /**
     * Builds drop foreign key sql.
     */
    protected dropForeignKeySql(table: Table, foreignKeyOrName: TableForeignKey|string): Query {
        const foreignKeyName = foreignKeyOrName instanceof TableForeignKey ? foreignKeyOrName.name : foreignKeyOrName;
        return new Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT \`${foreignKeyName}\``);
    }

    /**
     * Builds sequence name from given table and column.
     */
    protected buildSequenceName(table: Table, columnOrName: TableColumn|string): string {
        const { tableName } = this.driver.parseTableName(table);

        const columnName = columnOrName instanceof TableColumn ? columnOrName.name : columnOrName;

        let seqName = `${tableName}_${columnName}_seq`;

        if (seqName.length > this.connection.driver.maxAliasLength!) {
            // note doesn't yet handle corner cases where .length differs from number of UTF-8 bytes
            seqName = `${tableName.substring(0,29)}_${columnName.substring(0,Math.max(29,63 - (table.name.length) - 5))}_seq`;
        }

        return seqName;
    }

    protected buildSequencePath(table: Table, columnOrName: TableColumn|string): string {
        const { schema } = this.driver.parseTableName(table);

        return schema ? `${schema}.${this.buildSequenceName(table, columnOrName)}` : this.buildSequenceName(table, columnOrName);
    }

    /**
     * Builds ENUM type name from given table and column.
     */
    protected buildEnumName(table: Table, column: TableColumn, withSchema: boolean = true, disableEscape?: boolean, toOld?: boolean): string {
        const { schema, tableName } = this.driver.parseTableName(table);
        let enumName = column.enumName ? column.enumName : `${tableName}_${column.name.toLowerCase()}_enum`;
        if (schema && withSchema)
            enumName = `${schema}.${enumName}`
        if (toOld)
            enumName = enumName + "_old";
        return enumName.split(".").map(i => {
            return disableEscape ? i : `"${i}"`;
        }).join(".");
    }

    protected async getUserDefinedTypeName(table: Table, column: TableColumn) {
        let { schema, tableName: name } = this.driver.parseTableName(table);

        if (!schema) {
            schema = await this.getCurrentSchema();
        }

        const result = await this.query(`SELECT "udt_schema", "udt_name" ` +
            `FROM "information_schema"."columns" WHERE "table_schema" = '${schema}' AND "table_name" = '${name}' AND "column_name"='${column.name}'`);

        // docs: https://www.postgresql.org/docs/current/xtypes.html
        // When you define a new base type, PostgreSQL automatically provides support for arrays of that type.
        // The array type typically has the same name as the base type with the underscore character (_) prepended.
        // ----
        // so, we must remove this underscore character from enum type name
        let udtName = result[0]["udt_name"]
        if (udtName.indexOf("_") === 0) {
            udtName = udtName.substr(1, udtName.length)
        }
        return {
            schema: result[0]["udt_schema"],
            name: udtName
        };
    }

    /**
     * Escapes a given comment so it's safe to include in a query.
     */
    protected escapeComment(comment?: string) {
        if (!comment || comment.length === 0) {
            return "NULL";
        }

        comment = comment
            .replace(/'/g, "''")
            .replace(/\u0000/g, ""); // Null bytes aren't allowed in comments

        return `'${comment}'`;
    }

    /**
     * Escapes given table or view path.
     */
    protected escapePath(target: Table|View|string): string {
        // todo
        const { /*schema, */tableName } = this.driver.parseTableName(target);
        // if (schema && schema !== this.driver.searchSchema) {
        //     return `"${schema}"."${tableName}"`;
        // }

        return `\`${tableName}\``;
    }

    /**
     * Get the table name with table schema
     * Note: Without ' or "
     */
    protected async getTableNameWithSchema(target: Table|string) {
        const tableName = target instanceof Table ? target.name : target;
        if (tableName.indexOf(".") === -1) {
            const schemaResult = await this.query(`SELECT current_schema()`);
            const schema = schemaResult[0]["current_schema"];
            return `${schema}.${tableName}`;
        } else {
            return `${tableName.split(".")[0]}.${tableName.split(".")[1]}`;
        }
    }

    /**
     * Builds a part of query to create/change a column.
     */
    protected buildCreateColumnSql(column: TableColumn, skipName: boolean = false) {
        let c = `${this.driver.escape(column.name)} ${this.connection.driver.createFullType(column)}`

        if (column.asExpression)
            c += ` AS (${column.asExpression}) ${column.generatedType ? column.generatedType : "VIRTUAL"}`;

        if (column.enum)
            c += ` (${column.enum.map(value => "'" + value.replace(/'/g, "''") + "'").join(", ")})`;

        if (!column.isNullable)
            c += " NOT NULL";

        // if (column.isGenerated && column.generationStrategy === "increment")
        //     c += " AUTO_INCREMENT";
        // if (column.comment && column.comment.length > 0)
        //     c += ` COMMENT ${this.escapeComment(column.comment)}`;
        // if (column.default !== undefined && column.default !== null)
        //     c += ` DEFAULT ${column.default}`;
        // if (column.onUpdate)
        //     c += ` ON UPDATE ${column.onUpdate}`;

        return c;
    }

    /**
     * Executes sql used special for schema build.
     */
    protected async executeQueries(upQueries: Query|Query[], downQueries: Query|Query[]): Promise<void> {
        if (upQueries instanceof Query)
            upQueries = [upQueries];
        if (downQueries instanceof Query)
            downQueries = [downQueries];

        this.sqlInMemory.upQueries.push(...upQueries);
        this.sqlInMemory.downQueries.push(...downQueries);

        // if sql-in-memory mode is enabled then simply store sql in memory and return
        if (this.sqlMemoryMode === true)
            return Promise.resolve() as Promise<any>;

        for (const {query, parameters} of upQueries) {
            await this.updateDDL(query, parameters);
        }
    }

    /**
     * Checks if the PostgreSQL server has support for partitioned tables
     */
    protected async hasSupportForPartitionedTables() {
        const result = await this.query(`SELECT TRUE FROM information_schema.columns WHERE table_name = 'pg_class' and column_name = 'relispartition'`);
        return result.length ? true : false;
    }
}
