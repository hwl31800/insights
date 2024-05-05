import { DataModel } from '@/datamodel/useDataModel'
import { column, count, expression, mutate } from '@/query/next/query_utils'
import useQuery from '@/query/next/useQuery'
import { watchDebounced } from '@vueuse/core'
import { reactive, unref } from 'vue'
import {
	AXIS_CHARTS,
	AxisChartConfig,
	ChartConfig,
	ChartType,
	DountChartConfig,
	MetricChartConfig,
	TableChartConfig
} from './components/chart_utils'
import storeLocally from './storeLocally'

export function useAnalysisChart(name: string, model: DataModel) {
	const chart = reactive({
		name,
		type: 'Bar' as ChartType,
		config: {} as ChartConfig,
		query: useQuery(name),
		filters: [] as FilterArgs[],

		refresh: refreshChart,
		setFilters(filters: FilterArgs[]) {
			chart.filters = filters
		},

		serialize() {
			return {
				name: chart.name,
				type: chart.type,
				config: chart.config,
			}
		},
	})

	const storedChart = storeLocally<AnalysisChartSerialized>({
		key: 'name',
		namespace: 'insights:analysis-chart:',
		serializeFn: chart.serialize,
		defaultValue: {} as AnalysisChartSerialized,
	})
	if (storedChart.value.name === chart.name) {
		Object.assign(chart, storedChart.value)
	}

	watchDebounced(() => model.queries[0].currentOperations, refreshChart, {
		deep: true,
		debounce: 500,
	})

	watchDebounced(() => chart.config, refreshChart, { deep: true, debounce: 500 })

	async function refreshChart() {
		if (AXIS_CHARTS.includes(chart.type)) {
			const _config = unref(chart.config as AxisChartConfig)
			fetchAxisChartData(_config)
		}
		if (chart.type === 'Metric') {
			const _config = unref(chart.config as MetricChartConfig)
			fetchMetricChartData(_config)
		}
		if (chart.type === 'Donut') {
			const _config = unref(chart.config as DountChartConfig)
			fetchDonutChartData(_config)
		}
		if (chart.type === 'Table') {
			const _config = unref(chart.config as TableChartConfig)
			fetchTableChartData(_config)
		}
	}

	function fetchAxisChartData(config: AxisChartConfig) {
		if (!config.x_axis) {
			throw new Error('X-axis is required')
		}
		if (config.x_axis === config.split_by) {
			throw new Error('X-axis and split-by cannot be the same')
		}

		const row = model.getDimension(config.x_axis)
		if (!row) {
			throw new Error('X-axis column not found')
		}

		const column = model.getDimension(config.split_by)
		const values = config.y_axis?.map((y) => model.getMeasure(y)).filter(Boolean) as Measure[]

		prepareAxisChartQuery(row, column, values)
		chart.query.execute()
	}

	function prepareAxisChartQuery(row: Dimension, column?: Dimension, values?: Measure[]) {
		values = values?.length ? values : [count()]
		resetQuery()

		if (column) {
			chart.query.addPivotWider({
				rows: [row],
				columns: [column],
				values: values,
			})
		} else {
			chart.query.addSummarize({
				measures: values,
				dimensions: [row],
			})
		}
	}

	function fetchMetricChartData(config: MetricChartConfig) {
		if (config.target_value && config.target_column) {
			throw new Error('Target value and target column cannot be used together')
		}
		if (config.metric_column === config.target_column) {
			throw new Error('Metric and target cannot be the same')
		}
		if (config.target_column && config.date_column) {
			throw new Error('Target and date cannot be used together')
		}

		const metric = model.getMeasure(config.metric_column)
		if (!metric) {
			throw new Error('Metric column not found')
		}

		const date = model.getDimension(config.date_column as string)
		const target = config.target_value
			? Number(config.target_value)
			: model.getMeasure(config.target_column as string)

		prepareMetricQuery(metric, target, date)
		chart.query.execute()
	}

	function prepareMetricQuery(metric: Measure, target?: Measure | Number, date?: Dimension) {
		resetQuery()

		if (typeof target === 'number' && target > 0) {
			chart.query.addSummarize({
				measures: [metric],
				dimensions: [],
			})
			chart.query.addMutate(
				mutate({
					new_name: 'target',
					data_type: 'Decimal',
					mutation: expression(`literal(${target})`),
				})
			)
		} else if (typeof target === 'object') {
			chart.query.addSummarize({
				measures: [metric, target] as Measure[],
				dimensions: [],
			})
		} else if (date) {
			chart.query.addSummarize({
				measures: [metric],
				dimensions: [date],
			})
		} else {
			chart.query.addSummarize({
				measures: [metric],
				dimensions: [],
			})
		}
	}

	function fetchDonutChartData(config: DountChartConfig) {
		if (!config.label_column) {
			throw new Error('Label is required')
		}
		if (!config.value_column) {
			throw new Error('Value is required')
		}

		const label = model.getDimension(config.label_column)
		const value = model.getMeasure(config.value_column)
		if (!label) {
			throw new Error('Label column not found')
		}
		if (!value) {
			throw new Error('Value column not found')
		}

		prepareDonutQuery(label, value)
		chart.query.execute()
	}

	function prepareDonutQuery(label: Dimension, value: Measure) {
		resetQuery()

		chart.query.addSummarize({
			measures: [value],
			dimensions: [label],
		})
		chart.query.addOrderBy({
			column: column(value.column_name),
			direction: 'desc',
		})
	}

	function fetchTableChartData(config: TableChartConfig) {
		if (!config.rows.length) {
			throw new Error('Rows are required')
		}
		const rows = config.rows.map((r) => model.getDimension(r)).filter(Boolean) as Dimension[]
		const columns = config.columns.map((c) => model.getDimension(c)).filter(Boolean) as Dimension[]
		const values = config.values.map((v) => model.getMeasure(v)).filter(Boolean) as Measure[]

		prepareTableQuery(rows, columns, values)
		chart.query.execute()
	}

	function prepareTableQuery(rows: Dimension[], columns: Dimension[], values: Measure[]) {
		resetQuery()

		if (!columns.length) {
			chart.query.addSummarize({
				measures: values,
				dimensions: rows,
			})
		}
		if (columns.length) {
			chart.query.addPivotWider({
				rows: rows,
				columns: columns,
				values: values,
			})
		}
	}

	function resetQuery() {
		const modelQuery = model.queries[0]
		chart.query.autoExecute = false
		chart.query.setDataSource(modelQuery.dataSource)
		chart.query.setOperations([...modelQuery.operations])
		if (chart.filters.length) {
			chart.query.addFilter(chart.filters)
		}
	}

	return chart
}

export type AnalysisChart = ReturnType<typeof useAnalysisChart>
export type AnalysisChartSerialized = ReturnType<AnalysisChart['serialize']>
